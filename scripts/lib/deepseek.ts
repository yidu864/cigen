import { buildBrowserHeaders, fetchWithRetry, pickProfile, type FetchOptions } from './http';

/**
 * Reads public DeepSeek share links.
 *
 * The share page (`https://chat.deepseek.com/share/<id>`) loads its content from
 * `GET /api/v0/share/content?share_id=<id>`. That endpoint is public, but it is
 * fronted by the usual anti-bot plumbing, so requests are sent with a full
 * browser-like header set (matching user agent, `Referer` pointing at the share
 * page, fetch metadata, language preferences) and paced with a random delay.
 */

export const DEFAULT_BASE_URL = 'https://chat.deepseek.com';

export interface ShareMessage {
  messageId: number | string;
  role: string;
  status?: string;
  thinkingEnabled?: boolean;
  insertedAt?: number;
  fragments: Array<{ type: string; content: string }>;
}

export interface DeepSeekShare {
  shareId: string;
  title: string;
  modelType?: string;
  messages: ShareMessage[];
  fetchedAt: string;
  sourceUrl: string;
}

export interface FetchShareOptions extends FetchOptions {
  baseUrl?: string;
  /** Override the `Referer` (defaults to the share page itself). */
  referer?: string;
  userAgent?: string;
  uaProfile?: string;
  cookie?: string;
  proxy?: string;
}

export function sharePageUrl(shareId: string, baseUrl = DEFAULT_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}/share/${shareId}`;
}

export function shareContentUrl(shareId: string, baseUrl = DEFAULT_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`;
}

interface RawFragment {
  type?: string;
  content?: unknown;
}

interface RawMessage {
  message_id?: number | string;
  role?: string;
  status?: string;
  thinking_enabled?: boolean;
  inserted_at?: number;
  fragments?: RawFragment[];
}

interface RawShareResponse {
  code?: number;
  msg?: string;
  data?: {
    biz_code?: number;
    biz_msg?: string;
    biz_data?: {
      title?: string;
      model_type?: string;
      messages?: RawMessage[];
    };
  };
}

export function normalizeShare(
  shareId: string,
  payload: unknown,
  baseUrl?: string,
): DeepSeekShare {
  const response = (payload ?? {}) as RawShareResponse;
  const bizData = response?.data?.biz_data;
  if (!bizData || !Array.isArray(bizData.messages)) {
    const hint = response?.msg || response?.data?.biz_msg || '响应中没有 messages 字段';
    throw new Error(`无法解析分享内容 (share_id=${shareId}): ${hint}`);
  }

  return {
    shareId,
    title: bizData.title || `DeepSeek share ${shareId}`,
    modelType: bizData.model_type,
    fetchedAt: new Date().toISOString(),
    sourceUrl: sharePageUrl(shareId, baseUrl),
    messages: bizData.messages.map((message) => ({
      messageId: message.message_id ?? '',
      role: (message.role ?? 'UNKNOWN').toUpperCase(),
      status: message.status,
      thinkingEnabled: message.thinking_enabled,
      insertedAt: message.inserted_at,
      fragments: (message.fragments ?? [])
        .filter((fragment) => typeof fragment?.content === 'string')
        .map((fragment) => ({ type: (fragment.type ?? '').toUpperCase(), content: String(fragment.content) })),
    })),
  };
}

export async function fetchShare(
  shareId: string,
  options: FetchShareOptions = {},
): Promise<DeepSeekShare> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const referer = options.referer ?? sharePageUrl(shareId, baseUrl);
  const profile = options.userAgent
    ? { ...pickProfile(options.uaProfile), userAgent: options.userAgent }
    : pickProfile(options.uaProfile);

  const headers = buildBrowserHeaders({
    referer,
    profile,
    site: 'same-origin',
    cookie: options.cookie,
    extra: {
      // Ordinary fetch metadata for an XHR fired by the share page.
      'x-requested-with': 'XMLHttpRequest',
    },
  });

  const response = await fetchWithRetry(shareContentUrl(shareId, baseUrl), {
    ...options,
    headers,
    label: `share ${shareId}`,
  });

  if (!response.ok) {
    throw new Error(`获取分享内容失败 (share_id=${shareId}): HTTP ${response.status}`);
  }

  const payload = (await response.json()) as RawShareResponse;
  return normalizeShare(shareId, payload, baseUrl);
}

export interface TranscriptOptions {
  /** Include the learner's own messages (usually noise for extraction). */
  includeUserMessages?: boolean;
  /** Skip chain-of-thought fragments, they are not the final answer. */
  includeThinking?: boolean;
  maxMessages?: number;
}

/** Flatten a share into a plain-text transcript for the extraction prompt. */
export function toTranscript(share: DeepSeekShare, options: TranscriptOptions = {}): string {
  const parts: string[] = [];
  const messages = options.maxMessages ? share.messages.slice(-options.maxMessages) : share.messages;

  for (const message of messages) {
    if (message.role === 'USER') {
      if (!options.includeUserMessages) {
        continue;
      }
      const text = message.fragments
        .filter((fragment) => fragment.type === 'REQUEST' || fragment.type === '')
        .map((fragment) => fragment.content.trim())
        .filter(Boolean)
        .join('\n');
      if (text) {
        parts.push(`### 用户\n${text}`);
      }
      continue;
    }

    if (message.role !== 'ASSISTANT') {
      continue;
    }

    const text = message.fragments
      .filter((fragment) => {
        if (fragment.type === 'RESPONSE') {
          return true;
        }
        return options.includeThinking === true && fragment.type === 'THINK';
      })
      .map((fragment) => fragment.content.trim())
      .filter(Boolean)
      .join('\n\n');

    if (text) {
      parts.push(`### 助手\n${text}`);
    }
  }

  return parts.join('\n\n');
}

/** Split a transcript into chunks of at most `maxChars`, preferring blank lines. */
export function chunkTranscript(transcript: string, maxChars: number): string[] {
  if (maxChars <= 0 || transcript.length <= maxChars) {
    return [transcript];
  }

  const chunks: string[] = [];
  const paragraphs = transcript.split(/\n{2,}/);
  let current = '';

  const push = (): void => {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      push();
      for (let i = 0; i < paragraph.length; i += maxChars) {
        chunks.push(paragraph.slice(i, i + maxChars));
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > maxChars) {
      push();
    }
    current += (current ? '\n\n' : '') + paragraph;
  }
  push();

  return chunks.filter(Boolean);
}
