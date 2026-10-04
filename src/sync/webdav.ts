import type { Remote, RemoteResponse, RemoteSettings } from 'remotestoragejs/release/types/remote';

/**
 * A `Remote` implementation (the pluggable transport interface of
 * remoteStorage.js, the same extension point used by its bundled Dropbox and
 * Google Drive backends) that talks to any plain WebDAV collection.
 *
 * Tested against the behaviour expected by `remotestorage.js`'s Sync module:
 *
 * - `get('/folder/')` must resolve with an *items map*
 *   `{ 'file.json': { ETag, 'Content-Type', 'Content-Length' } }`
 *   (`PROPFIND Depth: 1` gives us exactly that).
 * - `get('/file.json')` resolves with the raw text body and the ETag revision.
 * - `put()` / `delete()` resolve with a status code; `412` signals a conflict.
 * - Network failures reject the promise, which makes Sync mark the remote
 *   offline and retry later.
 */

export interface WebDavOptions {
  /** Base collection URL, e.g. `https://dav.example.com/remote.php/dav/files/me/cigen/`. */
  url: string;
  username?: string;
  password?: string;
  /** Optional bearer token, takes precedence over basic auth. */
  bearerToken?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Optional fetch implementation (used by tests). */
  fetchImpl?: typeof fetch;
}

type Handler = (event?: unknown) => void;

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <d:getcontenttype/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`;

const ITEM_RE = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
const HREF_RE = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i;
const ETAG_RE = /<(?:[\w.-]+:)?getetag\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getetag>/i;
const LENGTH_RE =
  /<(?:[\w.-]+:)?getcontentlength\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getcontentlength>/i;
const TYPE_RE =
  /<(?:[\w.-]+:)?getcontenttype\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getcontenttype>/i;
const COLLECTION_RE = /<(?:[\w.-]+:)?collection\b[^>]*\/?>/i;

export function normalizeCollectionUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('WebDAV 地址不能为空');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`WebDAV 地址无效: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('WebDAV 地址必须以 http(s):// 开头');
  }
  // Drop query/hash, keep the directory part.
  parsed.search = '';
  parsed.hash = '';
  let path = parsed.pathname;
  if (!path.endsWith('/')) {
    path += '/';
  }
  return `${parsed.origin}${path}`;
}

export function isFolderPath(path: string): boolean {
  return path.length > 0 && path.endsWith('/');
}

function stripQuotes(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/^["']|["']$/g, '');
}

function addQuotes(value: string): string {
  if (value === '*') {
    return '*';
  }
  return `"${value.replace(/"/g, '')}"`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function encodePathSegments(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => (segment ? encodeURIComponent(segment) : segment))
    .join('/');
}

interface EntryMeta {
  ETag?: string;
  'Content-Type'?: string;
  'Content-Length'?: number;
}

export class WebDavRemote implements Remote {
  /**
   * WebDAV has no handshake: once a URL and credentials are configured the
   * remote counts as connected. remoteStorage.js checks this flag while loading
   * its features (`Sync#tasksWanted` refuses to do anything while the remote is
   * not connected), so it must be `true` from the start.
   */
  connected = true;
  online = true;
  userAddress = '';
  storageApi = 'draft-dejong-remotestorage-19';
  href = '';
  properties?: object;
  token?: string | false = false;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private username: string;
  private password: string;
  private bearerToken: string;
  private readonly handlers: Record<string, Handler[]> = {
    connected: [],
    'not-connected': [],
  };
  private readonly knownCollections = new Set<string>();

  constructor(options: WebDavOptions) {
    this.href = normalizeCollectionUrl(options.url);
    this.username = options.username ?? '';
    this.password = options.password ?? '';
    this.bearerToken = options.bearerToken ?? '';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get baseUrl(): string {
    return this.href;
  }

  on(eventName: string, handler: Handler): void {
    if (!this.handlers[eventName]) {
      this.handlers[eventName] = [];
    }
    this.handlers[eventName].push(handler);
  }

  removeEventListener(eventName: string, handler: Handler): void {
    const list = this.handlers[eventName];
    if (!list) {
      return;
    }
    const index = list.indexOf(handler);
    if (index >= 0) {
      list.splice(index, 1);
    }
  }

  private emit(eventName: string, payload?: unknown): void {
    (this.handlers[eventName] ?? []).slice().forEach((handler) => handler(payload));
  }

  configure(settings: RemoteSettings): void {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('WebDavRemote configure() expects an object');
    }
    if (typeof settings.href === 'string' && settings.href) {
      this.href = normalizeCollectionUrl(settings.href);
    }
    if (typeof settings.userAddress === 'string') {
      this.userAddress = settings.userAddress;
    }
    if (typeof settings.properties === 'object' && settings.properties !== null) {
      this.properties = settings.properties;
    }
    if (typeof settings.token === 'string') {
      this.bearerToken = settings.token;
    }
    this.connected = true;
    this.online = true;
    this.emit('connected');
  }

  stopWaitingForToken(): void {
    if (!this.connected) {
      this.emit('not-connected');
    }
  }

  /** Update credentials without going through the remoteStorage configure flow. */
  setCredentials(credentials: { username?: string; password?: string; bearerToken?: string }): void {
    if (credentials.username !== undefined) {
      this.username = credentials.username;
    }
    if (credentials.password !== undefined) {
      this.password = credentials.password;
    }
    if (credentials.bearerToken !== undefined) {
      this.bearerToken = credentials.bearerToken;
    }
  }

  isForbiddenRequestMethod(method: string, uri: string): boolean {
    if (method === 'PUT' || method === 'DELETE') {
      return isFolderPath(uri);
    }
    return false;
  }

  getItemURL(path: string): Promise<string | undefined> {
    return Promise.resolve(this.absoluteUrl(path));
  }

  /** Resolve a storage path like `/cigen/progress.json` to an absolute URL. */
  absoluteUrl(path: string): string {
    return this.href + encodePathSegments(path.replace(/^\/+/, ''));
  }

  /** PROPFIND the base collection; throws when the endpoint is unusable. */
  async testConnection(): Promise<{ ok: true; status: number } | { ok: false; status: number; message: string }> {
    const response = await this.request('PROPFIND', this.href, {
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    if (response.status === 207 || response.status === 200) {
      return { ok: true, status: response.status };
    }
    let message = `HTTP ${response.status}`;
    if (response.status === 401) {
      message = '认证失败（401）：请检查用户名 / 应用密码';
    } else if (response.status === 403) {
      message = '无权限（403）：请检查目录权限或 CORS 配置';
    } else if (response.status === 404) {
      message = '地址不存在（404）：请确认 WebDAV 目录路径';
    } else if (response.status === 405) {
      message = '服务器不支持 PROPFIND（405）：该地址可能不是 WebDAV 端点';
    }
    return { ok: false, status: response.status, message };
  }

  async get(
    path: string,
    options: { ifMatch?: string; ifNoneMatch?: string } = {},
  ): Promise<RemoteResponse> {
    if (!this.connected) {
      return Promise.reject(new Error(`not connected (path: ${path})`));
    }

    if (isFolderPath(path)) {
      return this.propfind(this.absoluteUrl(path));
    }

    const headers: Record<string, string> = {};
    if (options.ifNoneMatch) {
      headers['If-None-Match'] = addQuotes(options.ifNoneMatch);
    }

    const response = await this.request('GET', this.absoluteUrl(path), { headers });

    if (response.status === 304) {
      return { statusCode: 304, revision: stripQuotes(response.headers.get('etag')) };
    }
    if (response.status === 404) {
      return { statusCode: 404 };
    }
    if (response.status >= 400) {
      return { statusCode: response.status, revision: stripQuotes(response.headers.get('etag')) };
    }

    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    return {
      statusCode: response.status,
      body,
      contentType,
      revision: stripQuotes(response.headers.get('etag')),
    };
  }

  async put(
    path: string,
    body: XMLHttpRequestBodyInit,
    contentType: string,
    options: { ifMatch?: string; ifNoneMatch?: string } = {},
  ): Promise<RemoteResponse> {
    if (!this.connected) {
      return Promise.reject(new Error(`not connected (path: ${path})`));
    }
    if (isFolderPath(path)) {
      return Promise.reject(new Error(`Don't use PUT on directories! (${path})`));
    }

    const url = this.absoluteUrl(path);

    const send = (): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (contentType) {
        headers['Content-Type'] = contentType;
      }
      if (options.ifMatch) {
        headers['If-Match'] = addQuotes(options.ifMatch);
      }
      if (options.ifNoneMatch) {
        headers['If-None-Match'] = addQuotes(options.ifNoneMatch);
      }
      return this.request('PUT', url, { headers, body: body as BodyInit });
    };

    let response = await send();

    // Some servers refuse to create intermediate collections implicitly.
    if (response.status === 409 || response.status === 404 || response.status === 403) {
      const created = await this.ensureParentCollections(path);
      if (created) {
        response = await send();
      }
    }

    if (response.status === 412) {
      return { statusCode: 412, revision: 'conflict' };
    }
    if (response.status >= 400) {
      return { statusCode: response.status };
    }

    let revision = stripQuotes(response.headers.get('etag'));
    if (!revision) {
      revision = await this.fetchRevision(url);
    }
    return { statusCode: 200, revision };
  }

  async delete(path: string, options: { ifMatch?: string } = {}): Promise<RemoteResponse> {
    if (!this.connected) {
      return Promise.reject(new Error(`not connected (path: ${path})`));
    }

    const headers: Record<string, string> = {};
    if (options.ifMatch) {
      headers['If-Match'] = addQuotes(options.ifMatch);
    }

    const response = await this.request('DELETE', this.absoluteUrl(path), { headers });

    if (response.status === 404) {
      return { statusCode: 404 };
    }
    if (response.status === 412) {
      return { statusCode: 412, revision: 'conflict' };
    }
    if (response.status >= 400) {
      return { statusCode: response.status };
    }
    return { statusCode: 200 };
  }

  /** PROPFIND a collection and translate the multistatus document into an items map. */
  private async propfind(url: string): Promise<RemoteResponse> {
    const response = await this.request('PROPFIND', url, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });

    if (response.status === 404 || response.status === 401 || response.status === 403) {
      return { statusCode: response.status };
    }
    if (response.status === 405) {
      // Not a WebDAV collection after all — treat as "not found" rather than
      // failing the whole sync.
      return { statusCode: 404 };
    }
    if (response.status >= 400) {
      return { statusCode: response.status };
    }

    const xml = await response.text();
    const items = this.parseMultiStatus(xml, url);
    return {
      statusCode: 200,
      body: items,
      contentType: 'application/json; charset=utf-8',
      revision: stripQuotes(response.headers.get('etag')),
    };
  }

  private parseMultiStatus(xml: string, url: string): Record<string, EntryMeta> {
    const items: Record<string, EntryMeta> = {};
    const base = new URL(url);
    const basePath = decodeURIComponent(base.pathname);

    for (const match of xml.matchAll(ITEM_RE)) {
      const chunk = match[1];

      const hrefMatch = HREF_RE.exec(chunk);
      if (!hrefMatch) {
        continue;
      }
      const rawHref = decodeXmlEntities(hrefMatch[1]).trim();
      let childPath: string;
      try {
        childPath = decodeURIComponent(rawHref.startsWith('http') ? new URL(rawHref).pathname : rawHref);
      } catch {
        childPath = rawHref;
      }

      if (!childPath.startsWith(basePath)) {
        continue;
      }
      const relative = childPath.slice(basePath.length);

      // The collection itself is part of its own listing; skip it.
      if (!relative || relative === '/') {
        continue;
      }
      // Only direct children (guards against servers that ignore Depth: 1).
      const withoutTrailingSlash = relative.replace(/\/+$/, '');
      if (withoutTrailingSlash.includes('/')) {
        continue;
      }

      const isCollection = COLLECTION_RE.test(chunk);
      const etag = stripQuotes(decodeXmlEntities(ETAG_RE.exec(chunk)?.[1] ?? ''));
      const meta: EntryMeta = {};
      if (etag) {
        meta.ETag = etag;
      }

      if (isCollection) {
        items[`${withoutTrailingSlash}/`] = meta;
      } else {
        const type = decodeXmlEntities(TYPE_RE.exec(chunk)?.[1] ?? '').trim();
        if (type) {
          meta['Content-Type'] = type;
        }
        const length = decodeXmlEntities(LENGTH_RE.exec(chunk)?.[1] ?? '').trim();
        if (length && Number.isFinite(Number(length))) {
          meta['Content-Length'] = Number(length);
        }
        items[withoutTrailingSlash] = meta;
      }
    }

    return items;
  }

  private async fetchRevision(url: string): Promise<string | undefined> {
    try {
      const response = await this.request('PROPFIND', url, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      if (response.status >= 400) {
        return undefined;
      }
      const xml = await response.text();
      return stripQuotes(decodeXmlEntities(ETAG_RE.exec(xml)?.[1] ?? ''));
    } catch {
      return undefined;
    }
  }

  private async ensureParentCollections(path: string): Promise<boolean> {
    const cleaned = path.replace(/^\/+/, '');
    const segments = cleaned.split('/');
    segments.pop(); // file name
    let created = false;
    let current = '';
    for (const segment of segments) {
      if (!segment) {
        continue;
      }
      current += `/${segment}`;
      const collectionPath = `${current}/`;
      if (this.knownCollections.has(collectionPath)) {
        continue;
      }
      const response = await this.request('MKCOL', this.absoluteUrl(collectionPath), {});
      if (response.status === 201 || response.status === 200 || response.status === 301) {
        this.knownCollections.add(collectionPath);
        created = true;
      } else if (response.status === 405) {
        // 405 Method Not Allowed == the collection already exists.
        this.knownCollections.add(collectionPath);
      } else if (response.status >= 400) {
        this.log(`MKCOL ${collectionPath} -> HTTP ${response.status}`);
      }
    }
    return created;
  }

  private log(message: string): void {
    if (typeof console !== 'undefined') {
      console.warn(`[webdav] ${message}`);
    }
  }

  private async request(
    method: string,
    url: string,
    options: { headers?: Record<string, string>; body?: BodyInit },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: '*/*',
      ...(options.headers ?? {}),
    };

    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    } else if (this.username || this.password) {
      headers['Authorization'] = `Basic ${utf8ToBase64(`${this.username}:${this.password}`)}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body,
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'follow',
      });
    } catch (error) {
      this.markOffline();
      const reason = (error as Error)?.name === 'AbortError' ? 'timeout' : 'offline';
      throw reason;
    } finally {
      clearTimeout(timer);
    }

    this.markOnline();
    return response;
  }

  private markOffline(): void {
    if (this.online) {
      this.online = false;
      this.emit('network-offline');
    }
  }

  private markOnline(): void {
    if (!this.online) {
      this.online = true;
      this.emit('network-online');
    }
  }
}
