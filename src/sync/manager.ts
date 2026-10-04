import RemoteStorage from 'remotestoragejs';
import type BaseClient from 'remotestoragejs/release/types/baseclient';
import type { Remote } from 'remotestoragejs/release/types/remote';

import { WebDavRemote } from '@/sync/webdav';
import type { DatasetFile, Progress, SyncBackend } from '@/types';

export const SYNC_MODULE = 'cigen';
export const PROGRESS_FILE = 'progress.json';
export const DATASET_DIR = 'datasets/';

export interface SyncLogEntry {
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface SyncManagerState {
  backend: SyncBackend | null;
  connected: boolean;
  online: boolean;
  busy: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  userAddress: string;
}

export interface SyncManagerOptions {
  onLog?: (entry: SyncLogEntry) => void;
  onStateChange?: (state: SyncManagerState) => void;
  /** Called with the changed document paths whenever remote data changed. */
  onRemoteChange?: (paths: string[]) => void;
  /**
   * Called when the remote version of a document won against a local change
   * (remoteStorage.js resolves document conflicts in favour of the remote).
   * `localBody` is the losing local revision, so the app can merge and re-push.
   */
  onConflict?: (path: string, localBody: string | null, remoteBody: string | null) => void;
  /** Emitted on every successful sync cycle. */
  onSyncDone?: (completed: boolean) => void;
  fetchImpl?: typeof fetch;
}

export interface RemoteDocument {
  body: string | null;
  contentType: string;
  revision: string | undefined;
}

interface CigenModule {
  readDocument(path: string, localOnly: boolean): Promise<RemoteDocument>;
  writeDocument(path: string, contentType: string, body: string): Promise<string>;
  removeDocument(path: string): Promise<void>;
  getListing(path: string): Promise<Record<string, boolean>>;
}

type InternalRemoteStorage = RemoteStorage & {
  _emit: (eventName: string, ...args: unknown[]) => void;
};

const CACHE_READ_MAX_AGE = 2_000;

function decodeBody(data: unknown): string | null {
  if (data === null || data === undefined) {
    return null;
  }
  if (typeof data === 'string') {
    return data;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return null; // handled by the async wrapper
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView as Uint8Array);
  }
  if (typeof data === 'object') {
    return JSON.stringify(data);
  }
  return String(data);
}

async function readDocumentBody(data: unknown): Promise<string | null> {
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.text();
  }
  return decodeBody(data);
}

/** remoteStorage.js data module exposing plain JSON documents. */
function buildCigenModule() {
  return {
    name: SYNC_MODULE,
    builder: (privateClient: BaseClient) => {
      return {
        exports: {
          async readDocument(path: string, localOnly: boolean): Promise<RemoteDocument> {
            const file = (await privateClient.getFile(
              path,
              localOnly ? false : CACHE_READ_MAX_AGE,
            )) as {
              data: unknown;
              contentType?: string;
              revision?: string;
            };
            return {
              body: await readDocumentBody(file?.data),
              contentType: file?.contentType ?? 'application/json',
              revision: file?.revision,
            };
          },
          writeDocument(path: string, contentType: string, body: string): Promise<string> {
            return privateClient.storeFile(contentType, path, body);
          },
          removeDocument(path: string): Promise<void> {
            return privateClient.remove(path).then(() => undefined);
          },
          getListing(path: string): Promise<Record<string, boolean>> {
            return privateClient.getListing(path, CACHE_READ_MAX_AGE) as Promise<
              Record<string, boolean>
            >;
          },
        } satisfies CigenModule,
      };
    },
  };
}

export class SyncManager {
  readonly state: SyncManagerState = {
    backend: null,
    connected: false,
    online: false,
    busy: false,
    lastSyncAt: null,
    lastError: null,
    userAddress: '',
  };

  private readonly options: SyncManagerOptions;
  private rs: RemoteStorage | null = null;
  private webdav: WebDavRemote | null = null;
  private unsubscribe: Array<() => void> = [];
  private documentWatchers: Array<() => void> = [];

  constructor(options: SyncManagerOptions = {}) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.state.connected;
  }

  get webdavRemote(): WebDavRemote | null {
    return this.webdav;
  }

  private patch(partial: Partial<SyncManagerState>): void {
    Object.assign(this.state, partial);
    this.options.onStateChange?.({ ...this.state });
  }

  private log(level: SyncLogEntry['level'], message: string): void {
    const entry: SyncLogEntry = { time: new Date().toISOString(), level, message };
    this.options.onLog?.(entry);
  }

  // ------------------------------------------------------------------
  // connecting
  // ------------------------------------------------------------------

  /** Connect to a plain WebDAV collection. Throws when the endpoint is unusable. */
  async connectWebDav(config: { url: string; username?: string; password?: string }): Promise<void> {
    this.patch({ backend: 'webdav', lastError: null });
    const remote = new WebDavRemote({
      url: config.url,
      username: config.username,
      password: config.password,
      fetchImpl: this.options.fetchImpl,
    });

    const result = await remote.testConnection();
    if (!result.ok) {
      throw new Error(result.message);
    }
    this.log('info', `WebDAV 连接成功: ${remote.baseUrl}`);

    this.teardown();
    this.webdav = remote;
    this.createInstance('webdav', remote);
    this.attachProgressWatcher();
    this.patch({
      connected: true,
      online: true,
      backend: 'webdav',
      userAddress: config.username ? `${config.username}@webdav` : remote.baseUrl,
    });
  }

  /** Start the remoteStorage OAuth/WebFinger dance (redirects the browser). */
  connectRemoteStorage(userAddress: string): void {
    const rs = this.createInstance('remotestorage');
    this.patch({ backend: 'remotestorage', connected: false, lastError: null });
    this.log('info', `开始连接 remoteStorage: ${userAddress}`);
    rs.on('error', (error: unknown) => {
      this.patch({ lastError: String((error as Error)?.message ?? error) });
    });
    rs.connect(userAddress);
  }

  /** Start the Google Drive OAuth dance (redirects the browser). */
  connectGoogleDrive(clientId: string): void {
    const rs = this.createInstance('googledrive', null, clientId);
    this.patch({ backend: 'googledrive', connected: false, lastError: null });
    this.log('info', '开始连接 Google Drive');
    rs.on('error', (error: unknown) => {
      this.patch({ lastError: String((error as Error)?.message ?? error) });
    });
    // `Remote#connect` is the documented entry point for the non-remoteStorage
    // backends (the bundled Google Drive implementation redirects to Google).
    const remote = rs.remote as Remote & { connect?: () => void };
    if (typeof remote?.connect === 'function') {
      remote.connect();
    } else {
      this.patch({ lastError: 'Google Drive 后端未初始化，请填写客户端 ID 后重试' });
    }
  }

  /**
   * Re-create the remoteStorage instance from persisted credentials, e.g.
   * after a page reload or an OAuth redirect.
   */
  restoreWebDav(config: { url: string; username?: string; password?: string }): void {
    this.teardown();
    const remote = new WebDavRemote({
      url: config.url,
      username: config.username,
      password: config.password,
      fetchImpl: this.options.fetchImpl,
    });
    this.webdav = remote;
    this.createInstance('webdav', remote);
    this.attachProgressWatcher();
    this.patch({
      backend: 'webdav',
      connected: true,
      online: remote.online,
      userAddress: config.username ? `${config.username}@webdav` : remote.baseUrl,
    });
    this.log('info', `已恢复 WebDAV 会话: ${remote.baseUrl}`);
  }

  restoreRemoteStorage(): void {
    this.teardown();
    this.createInstance('remotestorage');
    this.attachProgressWatcher();
    this.patch({ backend: 'remotestorage' });
  }

  restoreGoogleDrive(clientId: string): void {
    this.teardown();
    this.createInstance('googledrive', null, clientId);
    this.attachProgressWatcher();
    this.patch({ backend: 'googledrive' });
  }

  // ------------------------------------------------------------------
  // instance plumbing
  // ------------------------------------------------------------------

  private createInstance(
    backend: SyncBackend,
    webdavRemote: WebDavRemote | null = null,
    googleClientId?: string,
  ): RemoteStorage {
    if (this.rs) {
      return this.rs;
    }

    const rs = new RemoteStorage({
      cache: true,
      changeEvents: { local: false, window: false, remote: true, conflict: true },
      modules: [buildCigenModule()],
    }) as InternalRemoteStorage;

    if (backend === 'googledrive' && googleClientId) {
      rs.setApiKeys({ googledrive: googleClientId });
      rs.setBackend('googledrive');
      if (rs.googledrive) {
        rs.remote = rs.googledrive as unknown as Remote;
      }
    } else if (backend === 'webdav' && webdavRemote) {
      rs.setBackend(undefined);
      // The swap happens synchronously, *before* remoteStorage.js finishes
      // loading its features (that part runs in a `setTimeout`), so SyncedGetPutDelete
      // and the Sync module are wired against the WebDAV transport from the start.
      rs.remote = webdavRemote as unknown as Remote;
    }

    this.rs = rs;
    // Claim read/write access for our data module (also used as the OAuth scope
    // for the remoteStorage protocol backend).
    try {
      rs.access.claim(SYNC_MODULE, 'rw');
    } catch (error) {
      this.log('warn', `声明访问权限失败: ${String(error)}`);
    }
    this.bindEvents(rs);

    // Feature loading is asynchronous; re-apply the transport reconfiguration
    // once everything is wired, in case a built-in backend won the race.
    rs.on('features-loaded', () => {
      if (backend === 'webdav' && webdavRemote && rs.remote !== (webdavRemote as unknown as Remote)) {
        rs.remote = webdavRemote as unknown as Remote;
        rs._emit('connected');
      }
      if (backend === 'googledrive' && rs.googledrive && rs.remote !== (rs.googledrive as unknown as Remote)) {
        rs.remote = rs.googledrive as unknown as Remote;
        if (rs.remote.connected) {
          rs._emit('connected');
        }
      }
      this.patch({ online: Boolean(rs.remote?.online) });
    });

    return rs;
  }

  private bindEvents(rs: RemoteStorage): void {
    const onConnected = (): void => {
      this.patch({ connected: true, online: true, lastError: null, userAddress: rs.remote?.userAddress ?? this.state.userAddress });
      this.log('info', '已连接到远端存储，开始同步');
      void rs.startSync().catch((error) => {
        this.log('error', `同步启动失败: ${String(error)}`);
      });
    };

    const onNotConnected = (): void => {
      this.patch({ connected: false });
    };

    const onSyncDone = (payload: unknown): void => {
      const completed = Boolean((payload as { completed?: boolean })?.completed);
      this.patch({ lastSyncAt: new Date().toISOString(), busy: false });
      if (!completed) {
        this.log('warn', '同步未能完成（远端离线或存在冲突），稍后会重试');
      } else {
        this.log('info', '同步完成');
      }
      this.options.onSyncDone?.(completed);
    };

    const onSyncStarted = (): void => {
      this.patch({ busy: true });
    };

    const onNetworkOffline = (): void => {
      this.patch({ online: false });
      this.log('warn', '远端不可达，进入离线模式');
    };

    const onNetworkOnline = (): void => {
      this.patch({ online: true });
    };

    const onError = (error: unknown): void => {
      const message = String((error as Error)?.message ?? error);
      this.patch({ lastError: message });
      this.log('error', message);
    };

    const onConflict = (): void => {
      this.log('warn', '检测到远端冲突，远端版本优先，随后会按合并规则写回');
    };

    rs.on('connected', onConnected);
    rs.on('not-connected', onNotConnected);
    rs.on('sync-done', onSyncDone);
    rs.on('sync-started', onSyncStarted);
    rs.on('network-offline', onNetworkOffline);
    rs.on('network-online', onNetworkOnline);
    rs.on('error', onError);
    rs.on('conflict', onConflict);

    this.unsubscribe = [
      () => rs.removeEventListener('connected', onConnected),
      () => rs.removeEventListener('not-connected', onNotConnected),
      () => rs.removeEventListener('sync-done', onSyncDone),
      () => rs.removeEventListener('sync-started', onSyncStarted),
      () => rs.removeEventListener('network-offline', onNetworkOffline),
      () => rs.removeEventListener('network-online', onNetworkOnline),
      () => rs.removeEventListener('error', onError),
      () => rs.removeEventListener('conflict', onConflict),
    ];
  }

  private client(): CigenModule | null {
    if (!this.rs) {
      return null;
    }
    return (this.rs as unknown as Record<string, CigenModule>)[SYNC_MODULE] ?? null;
  }

  private attachProgressWatcher(): void {
    const rs = this.rs;
    if (!rs) {
      return;
    }
    // `onChange` matches the *full* storage path, including the module prefix.
    const paths = [
      `/${SYNC_MODULE}/${PROGRESS_FILE}`,
      `/${SYNC_MODULE}/${DATASET_DIR}`,
    ];
    for (const path of paths) {
      rs.onChange(path, (event?: unknown) => {
        const change = (event ?? {}) as {
          origin?: string;
          path?: string;
          oldValue?: string | false;
          newValue?: string | false;
        };
        const changed = change.path ?? path;
        if (change.origin === 'conflict') {
          this.options.onConflict?.(
            changed,
            typeof change.oldValue === 'string' ? change.oldValue : null,
            typeof change.newValue === 'string' ? change.newValue : null,
          );
          return;
        }
        this.options.onRemoteChange?.([changed]);
      });
    }
    const instance = rs as unknown as { _pathHandlers?: { change: Record<string, unknown[]> } };
    this.documentWatchers = [
      () => {
        if (instance._pathHandlers) {
          for (const path of paths) {
            instance._pathHandlers.change[path] = [];
          }
        }
      },
    ];
  }

  // ------------------------------------------------------------------
  // operations
  // ------------------------------------------------------------------

  async syncNow(): Promise<boolean> {
    const rs = this.rs;
    if (!rs || !this.state.connected) {
      return false;
    }
    this.patch({ busy: true });

    const done = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        rs.removeEventListener('sync-done', handler);
        resolve(value);
      };
      const handler = (payload: unknown): void => {
        finish(Boolean((payload as { completed?: boolean })?.completed));
      };
      const timer = setTimeout(() => finish(false), 20_000);
      rs.on('sync-done', handler);
    });

    try {
      await rs.startSync();
    } catch (error) {
      this.patch({ busy: false, lastError: String(error) });
      this.log('error', `同步失败: ${String(error)}`);
      return false;
    }

    const completed = await done;
    this.patch({ busy: false, lastSyncAt: new Date().toISOString() });
    return completed;
  }

  async readDocument(path: string, options: { localOnly?: boolean } = {}): Promise<RemoteDocument | null> {
    const client = this.client();
    if (!client) {
      return null;
    }
    try {
      return await client.readDocument(path, options.localOnly === true);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (/404|not found/i.test(message)) {
        return null;
      }
      throw error;
    }
  }

  async writeDocument(path: string, value: unknown): Promise<void> {
    const client = this.client();
    if (!client) {
      throw new Error('尚未连接同步后端');
    }
    await client.writeDocument(path, 'application/json; charset=UTF-8', JSON.stringify(value));
  }

  async removeDocument(path: string): Promise<void> {
    const client = this.client();
    if (!client) {
      throw new Error('尚未连接同步后端');
    }
    await client.removeDocument(path);
  }

  async listDocuments(folder: string): Promise<string[]> {
    const client = this.client();
    if (!client) {
      return [];
    }
    try {
      const listing = await client.getListing(folder);
      return Object.keys(listing).filter((name) => name.endsWith('.json'));
    } catch (error) {
      this.log('warn', `读取目录 ${folder} 失败: ${String((error as Error)?.message ?? error)}`);
      return [];
    }
  }

  async readJson<T>(path: string, options: { localOnly?: boolean } = {}): Promise<T | null> {
    const document = await this.readDocument(path, options);
    if (!document?.body) {
      return null;
    }
    try {
      return JSON.parse(document.body) as T;
    } catch {
      this.log('warn', `${path} 不是合法 JSON，已忽略`);
      return null;
    }
  }

  readProgress(options: { localOnly?: boolean } = {}): Promise<Progress | null> {
    return this.readJson<Progress>(PROGRESS_FILE, options);
  }

  async writeProgress(progress: Progress): Promise<void> {
    return this.writeDocument(PROGRESS_FILE, progress);
  }

  async listDatasets(): Promise<string[]> {
    return this.listDocuments(DATASET_DIR);
  }
  readDataset(file: string, options: { localOnly?: boolean } = {}): Promise<DatasetFile | null> {
    return this.readJson<DatasetFile>(`${DATASET_DIR}${file}`, options);
  }

  writeDataset(file: string, dataset: unknown): Promise<void> {
    return this.writeDocument(`${DATASET_DIR}${file}`, dataset);
  }

  deleteDataset(file: string): Promise<void> {
    return this.removeDocument(`${DATASET_DIR}${file}`);
  }

  private teardown(): void {
    this.unsubscribe.forEach((off) => off());
    this.unsubscribe = [];
    this.documentWatchers.forEach((off) => off());
    this.documentWatchers = [];
    if (this.rs) {
      try {
        this.rs.stopSync();
        this.rs.disconnect();
      } catch (error) {
        this.log('warn', `断开旧连接时出错: ${String(error)}`);
      }
    }
    this.rs = null;
    this.webdav = null;
  }

  /** Disconnect and forget the current session. */
  disconnect(): void {
    this.teardown();
    this.patch({ connected: false, online: false, backend: null, userAddress: '', busy: false });
    this.log('info', '已断开同步连接');
  }

  /** Trigger the library's own reconnect flow (OAuth token refresh). */
  reconnect(): void {
    this.rs?.reconnect();
  }
}
