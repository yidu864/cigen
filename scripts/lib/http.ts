/**
 * Small HTTP helper with the "polite scraper" behaviour the import script
 * needs: browser-like headers, per-request jitter, retries with exponential
 * backoff, timeouts and an optional proxy.
 */

export interface BrowserProfile {
  name: string;
  userAgent: string;
  secChUa: string;
  platform: string;
  mobile: string;
}

/**
 * A couple of recent, realistic desktop browser fingerprints. The share
 * endpoint only needs `User-Agent` + `Referer`, but sending the same header set
 * a real Chrome would send keeps the request indistinguishable from a normal
 * visitor opening the share page.
 */
export const BROWSER_PROFILES: BrowserProfile[] = [
  {
    name: 'chrome-win-131',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Windows"',
    mobile: '?0',
  },
  {
    name: 'chrome-mac-130',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    platform: '"macOS"',
    mobile: '?0',
  },
  {
    name: 'edge-win-131',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    secChUa: '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Windows"',
    mobile: '?0',
  },
];

export function pickProfile(name?: string): BrowserProfile {
  if (!name) {
    return BROWSER_PROFILES[0];
  }
  const found = BROWSER_PROFILES.find((profile) => profile.name === name);
  if (!found) {
    throw new Error(
      `未知的 UA 预设 "${name}"，可选: ${BROWSER_PROFILES.map((p) => p.name).join(', ')}`,
    );
  }
  return found;
}

export interface BrowserHeaderOptions {
  /** Page the visitor "came from" — for shares that is the share page itself. */
  referer?: string;
  profile?: BrowserProfile;
  /** `same-origin` for XHRs fired by the share page. */
  site?: 'same-origin' | 'same-site' | 'cross-site' | 'none';
  accept?: string;
  acceptLanguage?: string;
  cookie?: string;
  extra?: Record<string, string>;
}

export function buildBrowserHeaders(options: BrowserHeaderOptions = {}): Record<string, string> {
  const profile = options.profile ?? BROWSER_PROFILES[0];
  const headers: Record<string, string> = {
    'user-agent': profile.userAgent,
    accept: options.accept ?? '*/*',
    'accept-language':
      options.acceptLanguage ?? 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,ja;q=0.6',
    'sec-ch-ua': profile.secChUa,
    'sec-ch-ua-mobile': profile.mobile,
    'sec-ch-ua-platform': profile.platform,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': options.site ?? 'same-origin',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    priority: 'u=1, i',
    dnt: '1',
  };

  if (options.referer) {
    headers.referer = options.referer;
    headers.origin = new URL(options.referer).origin;
    headers['sec-fetch-site'] = options.site ?? 'same-origin';
  }
  if (options.cookie) {
    headers.cookie = options.cookie;
  }

  return { ...headers, ...(options.extra ?? {}) };
}

export function jitter(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) {
    return Math.max(0, minMs);
  }
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

export interface FetchOptions {
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
  /** Minimum delay before the request, used to pace scraping. */
  minDelayMs?: number;
  maxDelayMs?: number;
  proxy?: string;
  method?: string;
  body?: string;
  label?: string;
}

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

async function buildDispatcher(proxy: string | undefined): Promise<unknown | undefined> {
  if (!proxy) {
    return undefined;
  }
  try {
    // Optional dependency: resolved at runtime so the script works without it.
    const specifier = 'undici';
    const undici = (await import(specifier)) as unknown as {
      ProxyAgent: new (url: string) => unknown;
    };
    return new undici.ProxyAgent(proxy);
  } catch {
    console.warn('⚠️  未安装 undici，--proxy 参数被忽略。可运行 `npm i -D undici` 启用代理支持。');
    return undefined;
  }
}

export async function fetchWithRetry(url: string, options: FetchOptions = {}): Promise<Response> {
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const dispatcher = await buildDispatcher(options.proxy);
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const wait = jitter(options.minDelayMs ?? 0, options.maxDelayMs ?? 0);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit & { dispatcher?: unknown } = {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
        redirect: 'follow',
      };
      if (dispatcher) {
        init.dispatcher = dispatcher;
      }

      const response = await fetch(url, init);
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(15_000, 800 * 2 ** (attempt - 1)) + jitter(0, 400);
        console.warn(
          `⚠️  ${options.label ?? url} 返回 HTTP ${response.status}，${backoff}ms 后重试（${attempt}/${retries}）`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      const reason = (error as Error)?.name === 'AbortError' ? '请求超时' : String(error);
      console.warn(`⚠️  ${options.label ?? url} 请求失败: ${reason}（${attempt}/${retries}）`);
      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(15_000, 700 * 2 ** (attempt - 1)) + jitter(0, 500)),
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `${options.label ?? url} 请求失败（已重试 ${retries} 次）: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
