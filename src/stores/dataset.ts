import { computed, reactive, ref } from 'vue';

import {
  BASE_DATASET_ID,
  BASE_DATASET_LABEL,
  loadBundledDatasets,
  type BundledDataset,
} from '@/data/loader';
import { buildRootToEntries, mergeDatasets, normalizeDataset } from '@/data/dataset';
import type { DatasetFile, Entry, RootInfo } from '@/types';

export interface DatasetSource {
  id: string;
  label: string;
  kind: 'bundled' | 'remote';
  file?: string;
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
  rebuild();
}

export async function loadDataset(): Promise<void> {
  datasetState.loading = true;
  datasetState.error = '';
  try {
    const bundle = await loadBundledDatasets();
    datasetState.warnings = bundle.errors;
    datasetState.sources = bundle.datasets.map(toSource);
    datasetState.activeSourceIds = bundle.datasets.map((item) => item.id);
    rebuild();
  } catch (error) {
    datasetState.error = (error as Error).message;
  } finally {
    datasetState.loading = false;
  }
}

function toSource(item: BundledDataset): DatasetSource {
  return { id: item.id, label: item.label, kind: 'bundled', file: item.file, dataset: item.dataset };
}

/** Add (or replace) a dataset that was pulled from the sync backend. */
export function upsertRemoteSource(
  id: string,
  label: string,
  raw: unknown,
  options: { activate?: boolean } = {},
): void {
  const dataset = normalizeDataset(raw);
  const source: DatasetSource = { id, label, kind: 'remote', file: `${id}.json`, dataset };
  const index = datasetState.sources.findIndex((item) => item.id === id);
  if (index >= 0) {
    datasetState.sources[index] = source;
  } else {
    datasetState.sources.push(source);
  }
  if (options.activate !== false && !datasetState.activeSourceIds.includes(id)) {
    datasetState.activeSourceIds = [...datasetState.activeSourceIds, id];
  }
  rebuild();
}

export function removeRemoteSource(id: string): void {
  datasetState.sources = datasetState.sources.filter((source) => source.id !== id);
  datasetState.activeSourceIds = datasetState.activeSourceIds.filter((item) => item !== id);
  rebuild();
}

export function bundledSources(): DatasetSource[] {
  return datasetState.sources.filter((source) => source.kind === 'bundled');
}

export const builtinSourceLabel = BASE_DATASET_LABEL;
