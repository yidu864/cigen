import { fetchWithRetry, jitter, type FetchOptions } from './http';

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Works with the official API, Azure-compatible gateways, DeepSeek, Moonshot,
 * Qwen, OpenRouter, Ollama (`/v1`) and anything else exposing
 * `POST {baseUrl}/chat/completions`.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  /** Ask the server for a JSON object (`response_format`). */
  jsonMode?: boolean;
  /** Disable the `response_format` field for servers that reject it. */
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  proxy?: string;
  label?: string;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResult {
  content: string;
  usage?: ChatUsage;
  model?: string;
}

interface RawChatResponse {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function extractContent(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

export async function chat(config: LlmConfig, messages: ChatMessage[]): Promise<ChatResult> {
  const url = normalizeBaseUrl(config.baseUrl);
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.2,
    stream: false,
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    ...(config.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
    ...(config.extraBody ?? {}),
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'cigen-importer/2.0 (+https://github.com/yuque/cigen)',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...(config.extraHeaders ?? {}),
  };

  const fetchOptions: FetchOptions = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    retries: config.retries ?? 3,
    timeoutMs: config.timeoutMs ?? 120_000,
    minDelayMs: 0,
    maxDelayMs: 250,
    proxy: config.proxy,
    label: config.label ?? `${config.model} chat/completions`,
  };

  const response = await fetchWithRetry(url, fetchOptions);
  const text = await response.text();

  if (!response.ok) {
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as RawChatResponse;
      detail = parsed.error?.message ?? detail;
    } catch {
      /* keep raw text */
    }
    throw new Error(`LLM 请求失败: HTTP ${response.status} — ${detail}`);
  }

  let parsed: RawChatResponse;
  try {
    parsed = JSON.parse(text) as RawChatResponse;
  } catch {
    throw new Error(`LLM 返回的不是 JSON: ${text.slice(0, 300)}`);
  }

  const content = extractContent(parsed.choices?.[0]?.message?.content);
  if (!content.trim()) {
    throw new Error('LLM 返回了空内容');
  }

  return {
    content,
    model: parsed.model,
    usage: parsed.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens,
        }
      : undefined,
  };
}

/** Strip ```json fences and any prose around the payload. */
export function extractJsonBlock(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    return fenced[1].trim();
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text.trim();
}

/** Chat and parse the answer as JSON, with one repair round trip on failure. */
export async function chatJson<T>(
  config: LlmConfig,
  messages: ChatMessage[],
  options: { onRetry?: (error: Error) => void } = {},
): Promise<T> {
  const first = await chat(config, messages);
  try {
    return JSON.parse(extractJsonBlock(first.content)) as T;
  } catch (error) {
    options.onRetry?.(error as Error);
    await new Promise((resolve) => setTimeout(resolve, jitter(200, 600)));
    const repaired = await chat(config, [
      ...messages,
      { role: 'assistant', content: first.content.slice(0, 4_000) },
      {
        role: 'user',
        content:
          '上一条回复不是合法 JSON。请只输出合法 JSON 对象，不要输出解释、Markdown 代码块标记或多余文本。',
      },
    ]);
    return JSON.parse(extractJsonBlock(repaired.content)) as T;
  }
}
