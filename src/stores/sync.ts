import { reactive, ref } from 'vue';

import { SyncManager, PROGRESS_FILE, type SyncLogEntry, type SyncManagerState } from '@/sync/manager';
import {
  mergeProgress,
  normalizeProgress,
  onProgressPersisted,
  progressEquals,
  replaceProgress,
  snapshotProgress,
} from '@/stores/progress';
import { removeSource, upsertRemoteSource, type DatasetSource } from '@/stores/dataset';
import type { Progress, SyncBackend, SyncConfig } from '@/types';

const CONFIG_KEY = 'cigen-sync-config-v1';
const SECRET_KEY = 'cigen-sync-webdav-secret';

function defaultConfig(): SyncConfig {
  return {
    backend: 'webdav',
    webdav: {
      url: import.meta.env.VITE_WEBDAV_URL ?? '',
      username: '',
      password: '',
    },
    remotestorage: {
      userAddress: import.meta.env.VITE_REMOTESTORAGE_ADDRESS ?? '',
    },
    googledrive: {
      clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
    },
    rememberPassword: false,
    autoPush: true,
  };
}

function readStoredSecret(): string {
  try {
    return localStorage.getItem(SECRET_KEY) ?? sessionStorage.getItem(SECRET_KEY) ?? '';
  } catch {
    return '';
  }
}

function loadConfig(): SyncConfig {
  const base = defaultConfig();
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SyncConfig>;
      base.backend = parsed.backend ?? base.backend;
      base.webdav = { ...base.webdav, ...(parsed.webdav ?? {}) };
      base.remotestorage = { ...base.remotestorage, ...(parsed.remotestorage ?? {}) };
      base.googledrive = { ...base.googledrive, ...(parsed.googledrive ?? {}) };
      base.rememberPassword = parsed.rememberPassword ?? base.rememberPassword;
      base.autoPush = parsed.autoPush ?? base.autoPush;
    }
  } catch {
    /* corrupted config — fall back to defaults */
  }
  base.webdav.password = readStoredSecret();
  return base;
}

export const syncConfig = reactive<SyncConfig>(loadConfig());

export const syncState = reactive<SyncManagerState>({
  backend: null,
  connected: false,
  online: false,
  busy: false,
  lastSyncAt: null,
  lastError: null,
  userAddress: '',
  pendingChanges: 0,
});

export const syncLogs = reactive<{ items: SyncLogEntry[] }>({ items: [] });
export const remoteDatasetFiles = ref<string[]>([]);
export const remoteDatasetIds = ref<string[]>([]);

const MAX_LOGS = 120;

let manager: SyncManager | null = null;
let syncingProgress = false;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

export function getManager(): SyncManager {
  if (!manager) {
    manager = new SyncManager({
      onLog(entry) {
        syncLogs.items.push(entry);
        if (syncLogs.items.length > MAX_LOGS) {
          syncLogs.items.splice(0, syncLogs.items.length - MAX_LOGS);
        }
      },
      onStateChange(state) {
        Object.assign(syncState, state);
      },
      onRemoteChange(paths) {
        if (paths.some((path) => path.endsWith('datasets/') || path.includes('/datasets/'))) {
          // The sync just refreshed the local cache, so read it locally.
          void refreshRemoteDatasets({ localOnly: true });
        } else if (paths.some((path) => path.endsWith(PROGRESS_FILE))) {
          // The remote version changed and won: adopt it locally (no network).
          void syncProgress({ silent: true, localOnly: true });
        }
      },
      onConflict(path, localBody, remoteBody) {
        if (!path.endsWith(PROGRESS_FILE)) {
          return;
        }
        const merged = mergeProgress(parseJson(localBody), parseJson(remoteBody));
        pushLog('warn', '进度在多个设备上同时变化，已按并集合并，将在下次「立即同步」时写回云端');
        if (!progressEquals(merged, snapshotProgress())) {
          replaceProgress(merged);
        }
        const remote = parseJson(remoteBody);
        if (!remote || !progressEquals(merged, remote)) {
          void getManager().writeProgress(merged);
        }
      },
      // Manual sync only: nothing is transferred unless the user clicks a
      // button, so there is no periodic work to do when a sync finishes.
      onSyncDone() {
        if (syncState.pendingChanges > 0 && !syncState.busy) {
          pushLog('info', `${syncState.pendingChanges} 项本地修改仍未同步`);
        }
      },
    });
  }
  return manager;
}

export function persistConfig(): void {
  try {
    const { password, ...restWebdav } = syncConfig.webdav;
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...syncConfig, webdav: restWebdav }));
    if (syncConfig.rememberPassword) {
      localStorage.setItem(SECRET_KEY, password ?? '');
      sessionStorage.removeItem(SECRET_KEY);
    } else {
      sessionStorage.setItem(SECRET_KEY, password ?? '');
      localStorage.removeItem(SECRET_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

export async function connect(): Promise<void> {
  const active = getManager();
  persistConfig();
  switch (syncConfig.backend) {
    case 'webdav':
      await active.connectWebDav({
        url: syncConfig.webdav.url,
        username: syncConfig.webdav.username,
        password: syncConfig.webdav.password,
      });
      break;
    case 'remotestorage':
      active.connectRemoteStorage(syncConfig.remotestorage.userAddress);
      return;
    case 'googledrive':
      active.connectGoogleDrive(syncConfig.googledrive.clientId);
      return;
  }
  await afterConnected();
}

export function disconnect(): void {
  getManager().disconnect();
  remoteDatasetFiles.value = [];
  remoteDatasetIds.value = [];
  persistConfig();
}

/**
 * Manual-sync mode: connecting must not touch the remote, otherwise the first
 * user interaction would already transfer data without them asking.
 */
async function afterConnected(): Promise<void> {
  pushLog('info', '自动同步已关闭：只有点击「立即同步 / 推送进度 / 拉取数据集」才会与云端交换数据');
}

export interface SyncProgressResult {
  progress: Progress;
  /** The merged value was stored locally and is waiting for the next sync run. */
  queuedWrite: boolean;
}

/** Merge remote + local progress and write the union back to the local cache. */
export async function syncProgress(
  options: { silent?: boolean; localOnly?: boolean } = {},
): Promise<SyncProgressResult | null> {
  const active = getManager();
  if (!syncState.connected || syncingProgress) {
    return null;
  }
  syncingProgress = true;
  try {
    const remote = await active.readProgress({ localOnly: options.localOnly === true });
    const local = snapshotProgress();
    const merged = mergeProgress(local, remote);
    if (!progressEquals(merged, local)) {
      replaceProgress(merged);
      if (!options.silent) {
        pushLog('info', `已合并云端进度：已掌握 ${Object.keys(merged.mastered).length} 个词根`);
      }
    }

    let queuedWrite = false;
    if (!remote || !progressEquals(merged, remote)) {
      await active.writeProgress(merged);
      queuedWrite = true;
    }
    return { progress: merged, queuedWrite };
  } catch (error) {
    pushLog('error', `同步进度失败: ${String((error as Error)?.message ?? error)}`);
    return null;
  } finally {
    syncingProgress = false;
  }
}

function parseJson(text: string | null): Progress | null {
  if (!text) {
    return null;
  }
  try {
    return normalizeProgress(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export async function pushProgressNow(): Promise<void> {
  const active = getManager();
  if (!syncState.connected) {
    return;
  }
  try {
    await active.writeProgress(snapshotProgress());
    await syncNow();
  } catch (error) {
    pushLog('error', `上传进度失败: ${String((error as Error)?.message ?? error)}`);
  }
}

function pushLog(level: SyncLogEntry['level'], message: string): void {
  syncLogs.items.push({ time: new Date().toISOString(), level, message });
  if (syncLogs.items.length > MAX_LOGS) {
    syncLogs.items.splice(0, syncLogs.items.length - MAX_LOGS);
  }
}

/**
 * The only place that transfers data. Triggered by the sync buttons:
 *
 * 1. run one remoteStorage.js sync round → uploads queued local writes and
 *    downloads remote changes into the local cache
 * 2. merge remote + local progress (purely local) and, if the merge changed
 *    anything, run one more round so the merged value reaches the remote
 *    without requiring a second click
 */
export async function syncNow(): Promise<boolean> {
  const active = getManager();
  if (!syncState.connected || syncState.busy) {
    return false;
  }

  const completed = await active.syncNow();

  const merged = await syncProgress({ silent: true, localOnly: true });
  if (merged?.queuedWrite) {
    await active.syncNow();
  }

  await refreshRemoteDatasets();
  return completed;
}

export async function refreshRemoteDatasets(
  options: { localOnly?: boolean } = {},
): Promise<string[]> {
  const active = getManager();
  if (!syncState.connected) {
    remoteDatasetFiles.value = [];
    remoteDatasetIds.value = [];
    return [];
  }
  try {
    const files = await active.listDatasets(options);
    remoteDatasetFiles.value = files;
    remoteDatasetIds.value = files.map((file) => file.replace(/\.json$/, ''));
    return files;
  } catch (error) {
    pushLog('warn', `读取云端数据集失败: ${String((error as Error)?.message ?? error)}`);
    return [];
  }
}

/** Upload a locally loaded dataset so other devices can pull it. */
export async function uploadDataset(source: DatasetSource): Promise<void> {
  const active = getManager();
  if (!syncState.connected) {
    throw new Error('尚未连接同步后端');
  }
  const file = `${source.id}.json`;
  await active.writeDataset(file, source.dataset);
  pushLog('info', `已上传数据集 ${source.label} (${file})`);
  await active.syncNow();
  await refreshRemoteDatasets();
}

export async function pullDataset(file: string): Promise<void> {
  const active = getManager();
  if (!syncState.connected) {
    throw new Error('尚未连接同步后端');
  }
  const dataset = await active.readDataset(file);
  if (!dataset) {
    throw new Error(`云端没有 ${file}`);
  }
  const id = file.replace(/\.json$/, '');
  upsertRemoteSource(id, dataset.meta?.label ? String(dataset.meta.label) : id, dataset);
  pushLog('info', `已拉取数据集 ${file}`);
}

export async function deleteRemoteDataset(file: string): Promise<void> {
  const active = getManager();
  if (!syncState.connected) {
    throw new Error('尚未连接同步后端');
  }
  await active.deleteDataset(file);
  await removeSource(file.replace(/\.json$/, ''));
  pushLog('info', `已删除云端数据集 ${file}`);
  await active.syncNow();
  await refreshRemoteDatasets();
}

/**
 * Re-attach after a reload / OAuth redirect. Returns true when a stored
 * session was restored.
 */
export async function restoreSession(): Promise<boolean> {
  const active = getManager();
  persistConfig();

  if (syncConfig.backend === 'webdav') {
    if (!syncConfig.webdav.url) {
      return false;
    }
    active.restoreWebDav({
      url: syncConfig.webdav.url,
      username: syncConfig.webdav.username,
      password: syncConfig.webdav.password,
    });
    await afterConnected();
    return true;
  }

  if (syncConfig.backend === 'googledrive') {
    if (!syncConfig.googledrive.clientId) {
      return false;
    }
    active.restoreGoogleDrive(syncConfig.googledrive.clientId);
  } else {
    if (!syncConfig.remotestorage.userAddress) {
      return false;
    }
    active.restoreRemoteStorage();
  }

  // OAuth backends restore their token from localStorage inside the library;
  // wait a moment for the "connected" event before pulling.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (syncState.connected) {
    await afterConnected();
    return true;
  }
  return false;
}

/** Register the automatic progress push used when `autoPush` is enabled. */
export function startProgressAutoPush(): () => void {
  return onProgressPersisted((snapshot) => {
    if (!syncConfig.autoPush || !syncState.connected) {
      return;
    }
    if (pushTimer !== undefined) {
      clearTimeout(pushTimer);
    }
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      void getManager().writeProgress(snapshot);
    }, 800);
  });
}

export function setBackend(backend: SyncBackend): void {
  syncConfig.backend = backend;
  persistConfig();
}

export function clearLogs(): void {
  syncLogs.items.splice(0, syncLogs.items.length);
}
