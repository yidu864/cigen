import { computed, reactive, ref } from 'vue';

import {
  BASE_DATASET_ID,
  loadBundledDatasets,
  type BundledDataset,
} from '@/data/loader';
import { buildRootToEntries, entryKey, mergeDatasets, normalizeDataset } from '@/data/dataset';
import {
  deleteStoredDataset,
  listStoredDatasets,
  saveStoredDataset,
  type StoredDataset,
} from '@/data/localStore';
import type { DatasetFile, Entry, RootInfo } from '@/types';

export type DatasetSourceKind = 'bundled' | 'imported' | 'remote';

export interface DatasetSource {
  id: string;
  label: string;
  kind: DatasetSourceKind;
  file?: string;
  importedAt?: string;
  dataset: DatasetFile;
}

interface DatasetState {
  loading: boolean;
  error: string;
  warnings: string[];
  sources: DatasetSource[];
  /** Ids that are currently active (used for the selector). */
  activeSourceIds: string[];
  entries: Entry[];
  roots: RootInfo[];
  rootMap: Map<string, RootInfo>;
  rootToEntries: Map<string, Entry[]>;
}

export const datasetState = reactive<DatasetState>({
  loading: true,
  error: '',
  warnings: [],
  sources: [],
  activeSourceIds: [],
  entries: [],
  roots: [],
  rootMap: new Map(),
  rootToEntries: new Map(),
});

const mergedStats = ref<Record<string, { entries: number; roots: number }>>({});

export const sourceStats = computed(() =>
  datasetState.sources.map((source) => ({
    id: source.id,
    label: source.label,
    kind: source.kind,
    entries: mergedStats.value[source.id]?.entries ?? 0,
    roots: mergedStats.value[source.id]?.roots ?? source.dataset.roots?.length ?? 0,
    generatedAt: source.dataset.meta?.generatedAt,
  })),
);

export const importableSources = computed(() =>
  datasetState.sources.filter((source) => source.kind !== 'bundled'),
);

const ENABLED_KEY = 'cigen-enabled-datasets-v1';

function readEnabledIds(): string[] | null {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

function writeEnabledIds(): void {
  try {
    localStorage.setItem(ENABLED_KEY, JSON.stringify(datasetState.activeSourceIds));
  } catch {
    /* ignore */
  }
}

function rebuild(): void {
  const active = datasetState.sources.filter((source) =>
    datasetState.activeSourceIds.includes(source.id),
  );
  const merged = mergeDatasets(
    active.map((source) => ({ id: source.id, label: source.label, dataset: source.dataset })),
  );

  const stats: Record<string, { entries: number; roots: number }> = {};
  for (const stat of merged.sources) {
    stats[stat.id] = { entries: stat.entries, roots: stat.roots };
  }
  mergedStats.value = stats;

  datasetState.entries = merged.dataset.entries ?? [];
  datasetState.roots = merged.dataset.roots ?? [];
  datasetState.rootMap = new Map(datasetState.roots.map((root) => [root.root, root]));
  datasetState.rootToEntries = buildRootToEntries(datasetState.entries);
}

export function setSourceEnabled(id: string, enabled: boolean): void {
  const next = new Set(datasetState.activeSourceIds);
  if (enabled) {
    next.add(id);
  } else {
    next.delete(id);
  }
  // The built-in dataset is always available so the app never ends up empty.
  next.add(BASE_DATASET_ID);
  datasetState.activeSourceIds = [...next];
  writeEnabledIds();
  rebuild();
}

function applyEnabledState(defaultIds: string[]): void {
  const stored = readEnabledIds();
  const known = new Set(datasetState.sources.map((source) => source.id));
  const wanted = (stored ?? defaultIds).filter((id) => known.has(id));
  wanted.push(BASE_DATASET_ID);
  datasetState.activeSourceIds = [...new Set(wanted)];
  writeEnabledIds();
}

/** Load the built-in dataset, every bundled dataset and the user's imports. */
export async function loadDataset(): Promise<void> {
  datasetState.loading = true;
  datasetState.error = '';
  try {
    const bundle = await loadBundledDatasets();
    datasetState.warnings = bundle.errors;
    datasetState.sources = bundle.datasets.map(toSource);
    datasetState.activeSourceIds = bundle.datasets.map((item) => item.id);
    rebuild();

    await loadImportedDatasets();
  } catch (error) {
    datasetState.error = (error as Error).message;
  } finally {
    datasetState.loading = false;
  }
}

/** Restore datasets the user imported in this browser. */
export async function loadImportedDatasets(): Promise<number> {
  let stored: StoredDataset[] = [];
  try {
    stored = await listStoredDatasets();
  } catch (error) {
    datasetState.warnings = [
      ...datasetState.warnings,
      `读取本地导入数据集失败: ${(error as Error).message}`,
    ];
    return 0;
  }

  const bundledIds = new Set(
    datasetState.sources.filter((source) => source.kind === 'bundled').map((source) => source.id),
  );
  let restored = 0;
  for (const item of stored) {
    if (bundledIds.has(item.id)) {
      continue;
    }
    upsertSource({
      id: item.id,
      label: item.label,
      kind: 'imported',
      file: item.filename,
      importedAt: item.importedAt,
      dataset: item.dataset,
    });
    restored += 1;
  }
  if (restored > 0) {
    applyEnabledState(datasetState.activeSourceIds);
  }
  return restored;
}

function toSource(item: BundledDataset): DatasetSource {
  return { id: item.id, label: item.label, kind: 'bundled', file: item.file, dataset: item.dataset };
}

function upsertSource(source: DatasetSource): void {
  const index = datasetState.sources.findIndex((item) => item.id === source.id);
  if (index >= 0) {
    datasetState.sources[index] = source;
  } else {
    datasetState.sources.push(source);
  }
}

/** Make `id` unique so an import never silently replaces another dataset. */
function uniqueId(rawId: string): string {
  const base = rawId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
  let candidate = base;
  let counter = 2;
  while (datasetState.sources.some((source) => source.id === candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function suggestId(input: { id?: string; filename?: string; label?: string }): string {
  if (input.id) {
    return input.id;
  }
  if (input.filename) {
    return input.filename.replace(/\.json$/i, '');
  }
  if (input.label) {
    return input.label;
  }
  return `imported-${new Date().toISOString().slice(0, 10)}`;
}

export interface ImportedDatasetSummary {
  id: string;
  label: string;
  entries: number;
  roots: number;
  /** First few words, used to confirm the file parsed as expected. */
  preview: string[];
  /** Entries that other active datasets already contain. */
  overlap: number;
}

export interface ImportDatasetInput {
  /** Raw parsed JSON. Arrays are treated as a list of entries. */
  raw: unknown;
  label?: string;
  filename?: string;
  id?: string;
  /** Persist to IndexedDB (default) so it survives a reload. */
  persist?: boolean;
  activate?: boolean;
}

/**
 * Validate and register a dataset that came from a file, a paste or a URL.
 * Throws with a user-facing message when nothing usable was found.
 */
export async function importDataset(input: ImportDatasetInput): Promise<ImportedDatasetSummary> {
  const cleaned = Array.isArray(input.raw) ? { entries: input.raw } : input.raw;
  const dataset = normalizeDataset(cleaned);
  const entries = dataset.entries ?? [];

  if (entries.length === 0) {
    throw new Error(
      '这个 JSON 里没有可用的词条（需要 entries 数组，且每项至少包含 word 与 decomposition / components）。',
    );
  }

  const label =
    input.label?.trim() ||
    (typeof dataset.meta?.label === 'string' && dataset.meta.label) ||
    input.filename?.replace(/\.json$/i, '') ||
    '导入数据集';

  const requested = suggestId({ id: input.id, filename: input.filename, label });
  const existing = datasetState.sources.find((source) => source.id === requested);
  const id = existing && existing.kind === 'imported' ? existing.id : uniqueId(requested);

  // Recompute the index locally so wordCount / sampleWords / gloss match the
  // built-in dataset even if the file only contains `entries`.
  const normalized = normalizeDataset({ meta: dataset.meta, entries });

  const knownKeys = new Set<string>();
  for (const source of datasetState.sources) {
    if (source.id === id || !datasetState.activeSourceIds.includes(source.id)) {
      continue;
    }
    for (const entry of source.dataset.entries ?? []) {
      knownKeys.add(entryKey(entry));
    }
  }
  const overlap = (normalized.entries ?? []).filter((entry) => knownKeys.has(entryKey(entry))).length;

  const importedAt = new Date().toISOString();
  const source: DatasetSource = {
    id,
    label,
    kind: 'imported',
    file: input.filename,
    importedAt,
    dataset: normalized,
  };
  upsertSource(source);

  if (input.activate !== false && !datasetState.activeSourceIds.includes(id)) {
    datasetState.activeSourceIds = [...datasetState.activeSourceIds, id];
  }
  writeEnabledIds();
  rebuild();

  if (input.persist !== false) {
    await saveStoredDataset({
      id,
      label,
      filename: input.filename,
      importedAt,
      dataset: normalized,
    });
  }

  return {
    id,
    label,
    entries: normalized.entries?.length ?? 0,
    roots: normalized.roots?.length ?? 0,
    preview: (normalized.entries ?? []).slice(0, 6).map((entry) => entry.word),
    overlap,
  };
}

/** Add (or replace) a dataset that was pulled from the sync backend. */
export function upsertRemoteSource(
  id: string,
  label: string,
  raw: unknown,
  options: { activate?: boolean } = {},
): void {
  const dataset = normalizeDataset(raw);
  upsertSource({ id, label, kind: 'remote', file: `${id}.json`, dataset });
  if (options.activate !== false && !datasetState.activeSourceIds.includes(id)) {
    datasetState.activeSourceIds = [...datasetState.activeSourceIds, id];
    writeEnabledIds();
  }
  rebuild();
}

/** Remove a source. Imported datasets are also deleted from IndexedDB. */
export async function removeSource(id: string): Promise<void> {
  const source = datasetState.sources.find((item) => item.id === id);
  if (!source || source.kind === 'bundled') {
    return;
  }
  datasetState.sources = datasetState.sources.filter((item) => item.id !== id);
  datasetState.activeSourceIds = datasetState.activeSourceIds.filter((item) => item !== id);
  datasetState.activeSourceIds = [...new Set([...datasetState.activeSourceIds, BASE_DATASET_ID])];
  writeEnabledIds();
  rebuild();

  if (source.kind === 'imported') {
    try {
      await deleteStoredDataset(id);
    } catch (error) {
      console.warn('[datasets] 删除本地数据集失败', error);
    }
  }
}

export { BASE_DATASET_ID, BASE_DATASET_LABEL } from '@/data/loader';
