import type { DatasetFile } from '@/types';

/**
 * Persistence for datasets the user imported in the browser (file picker,
 * drag & drop, pasted JSON or a URL). Datasets are big-ish (a few hundred KB),
 * so IndexedDB is the primary store with a localStorage fallback for private
 * mode / browsers without IndexedDB.
 */

export interface StoredDataset {
  id: string;
  label: string;
  filename?: string;
  importedAt: string;
  dataset: DatasetFile;
}

const DB_NAME = 'cigen';
const DB_VERSION = 1;
const STORE_NAME = 'datasets';
const FALLBACK_KEY = 'cigen-imported-datasets-v1';

let dbPromise: Promise<IDBDatabase | null> | null = null;
let memoryFallback: Map<string, StoredDataset> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function readFallback(): Map<string, StoredDataset> {
  if (memoryFallback) {
    return memoryFallback;
  }
  memoryFallback = new Map();
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredDataset[];
      for (const item of parsed) {
        if (item && typeof item.id === 'string') {
          memoryFallback.set(item.id, item);
        }
      }
    }
  } catch {
    /* ignore unreadable fallback storage */
  }
  return memoryFallback;
}

function writeFallback(): void {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify([...(memoryFallback ?? new Map()).values()]));
  } catch (error) {
    console.warn('[datasets] 本地存储写入失败（可能超出配额）', error);
  }
}

function runTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务中止'));
  });
}

export async function listStoredDatasets(): Promise<StoredDataset[]> {
  const db = await openDatabase();
  if (!db) {
    return [...readFallback().values()].sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  }
  try {
    const items = await runTransaction<StoredDataset[]>(db, 'readonly', (store) => store.getAll());
    return items.sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  } catch (error) {
    console.warn('[datasets] 读取本地数据集失败', error);
    return [];
  }
}

export async function saveStoredDataset(entry: StoredDataset): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    readFallback().set(entry.id, entry);
    writeFallback();
    return;
  }
  await runTransaction(db, 'readwrite', (store) => store.put(entry));
}

export async function deleteStoredDataset(id: string): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    readFallback().delete(id);
    writeFallback();
    return;
  }
  await runTransaction(db, 'readwrite', (store) => store.delete(id));
}

export async function clearStoredDatasets(): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    readFallback().clear();
    writeFallback();
    return;
  }
  await runTransaction(db, 'readwrite', (store) => store.clear());
}
