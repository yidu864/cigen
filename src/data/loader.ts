import { mergeDatasets, normalizeDataset } from '@/data/dataset';
import type { DatasetFile, DatasetManifest, DatasetManifestItem } from '@/types';

const DATA_ROOT = `${import.meta.env.BASE_URL}data/`;
export const BASE_DATASET_ID = 'base';
export const BASE_DATASET_LABEL = '内置数据集 (PDF 提取)';

export const BASE_DATASET_URL = `${DATA_ROOT}roots_affixes.json`;
export const DATASET_MANIFEST_URL = `${DATA_ROOT}datasets/index.json`;

export async function fetchJson(url: string): Promise<unknown | null> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  return (await response.json()) as unknown;
}

export interface BundledDataset {
  id: string;
  label: string;
  file: string;
  url: string;
  dataset: DatasetFile;
}

export interface LoadedBundle {
  merged: ReturnType<typeof mergeDatasets>;
  datasets: BundledDataset[];
  /** Errors for datasets that failed to load, they do not abort the app. */
  errors: string[];
}

/** Load the built-in dataset plus every dataset listed in the manifest. */
export async function loadBundledDatasets(): Promise<LoadedBundle> {
  const errors: string[] = [];
  const datasets: BundledDataset[] = [];

  const baseRaw = await fetchJson(BASE_DATASET_URL);
  if (!baseRaw) {
    throw new Error(`找不到内置数据文件: ${BASE_DATASET_URL}`);
  }
  datasets.push({
    id: BASE_DATASET_ID,
    label: BASE_DATASET_LABEL,
    file: 'roots_affixes.json',
    url: BASE_DATASET_URL,
    dataset: normalizeDataset(baseRaw),
  });

  let manifest: DatasetManifest | null = null;
  try {
    manifest = (await fetchJson(DATASET_MANIFEST_URL)) as DatasetManifest | null;
  } catch (error) {
    errors.push(`读取数据集清单失败: ${(error as Error).message}`);
  }

  for (const item of manifest?.datasets ?? []) {
    const url = `${DATA_ROOT}datasets/${item.file.replace(/^\/+/, '')}`;
    try {
      const raw = await fetchJson(url);
      if (!raw) {
        errors.push(`数据集 ${item.id} 不存在: ${url}`);
        continue;
      }
      datasets.push({
        id: item.id,
        label: item.label ?? item.id,
        file: item.file,
        url,
        dataset: normalizeDataset(raw),
      });
    } catch (error) {
      errors.push(`数据集 ${item.id} 加载失败: ${(error as Error).message}`);
    }
  }

  const merged = mergeDatasets(
    datasets.map((item) => ({ id: item.id, label: item.label, dataset: item.dataset })),
  );

  return { merged, datasets, errors };
}

export type { DatasetManifestItem };
