/**
 * Installs the minimal browser globals remoteStorage.js expects when the tests
 * run in Node (its caching layer degrades from IndexedDB to localStorage).
 *
 * Must be imported *before* `remotestoragejs`.
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const globals = globalThis as unknown as Record<string, unknown>;

if (!globals.localStorage) {
  globals.localStorage = new MemoryStorage();
}
if (!globals.sessionStorage) {
  globals.sessionStorage = new MemoryStorage();
}

export {};
