import type { DatasetFile, Entry, RootComponent, RootInfo } from '@/types';

/**
 * Rebuild the root/affix index from a list of entries.
 *
 * This is a TypeScript port of `build_root_index()` in
 * `scripts/extract_pdf_data.py`, so PDF-extracted and DeepSeek-imported
 * datasets produce comparable indexes.
 */
export function buildRoots(entries: Entry[]): RootInfo[] {
  const counts = new Map<string, number>();
  const hints = new Map<string, Map<string, number>>();
  const words = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();

  for (const entry of entries) {
    const word = entry.word;
    for (const component of entry.components ?? []) {
      const root = component.morpheme;
      if (!root) {
        continue;
      }
      counts.set(root, (counts.get(root) ?? 0) + 1);

      if (component.hint) {
        let hintMap = hints.get(root);
        if (!hintMap) {
          hintMap = new Map();
          hints.set(root, hintMap);
        }
        hintMap.set(component.hint, (hintMap.get(component.hint) ?? 0) + 1);
      }

      let seenSet = seen.get(root);
      if (!seenSet) {
        seenSet = new Set();
        seen.set(root, seenSet);
      }
      if (!seenSet.has(word)) {
        seenSet.add(word);
        const list = words.get(root);
        if (list) {
          list.push(word);
        } else {
          words.set(root, [word]);
        }
      }
    }
  }

  const roots: RootInfo[] = [];
  for (const [root, count] of counts) {
    if (count < 2) {
      continue;
    }

    roots.push({
      root,
      gloss: bestHint(hints.get(root)),
      wordCount: words.get(root)?.length ?? 0,
      sampleWords: (words.get(root) ?? []).slice(0, 12),
    });
  }

  roots.sort((a, b) => b.wordCount - a.wordCount || a.root.localeCompare(b.root));
  return roots;
}

const CJK_RE = /[\u4e00-\u9fff]/;
const LATIN_RE = /[A-Za-z]/;

function bestHint(hintMap: Map<string, number> | undefined): string {
  if (!hintMap || hintMap.size === 0) {
    return '';
  }

  const candidates: Array<[string, number]> = [];
  for (const [hint, freq] of hintMap) {
    if (!CJK_RE.test(hint)) {
      continue;
    }
    if (hint.length > 18) {
      continue;
    }
    if (LATIN_RE.test(hint)) {
      continue;
    }
    candidates.push([hint, freq]);
  }

  const pool = candidates.length > 0 ? candidates : [...hintMap.entries()];
  pool.sort((a, b) => {
    const aCjk = CJK_RE.test(a[0]) ? 0 : 1;
    const bCjk = CJK_RE.test(b[0]) ? 0 : 1;
    if (aCjk !== bCjk) {
      return aCjk - bCjk;
    }
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    if (a[0].length !== b[0].length) {
      return a[0].length - b[0].length;
    }
    return a[0].localeCompare(b[0]);
  });

  return pool[0]?.[0] ?? '';
}

/** Split a `decomposition` string into components. */
export function parseDecomposition(decomposition: string): RootComponent[] {
  if (!decomposition) {
    return [];
  }
  const parts = decomposition.split('+');
  const components: RootComponent[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const piece = part.trim();
    if (!piece) {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z'-]*)([\s\S]*)$/.exec(piece);
    if (!match) {
      continue;
    }
    const morpheme = match[1].toLowerCase().replace(/^-+|-+$/g, '');
    if (!morpheme) {
      continue;
    }
    if (morpheme.length === 1 && morpheme !== 'a') {
      continue;
    }
    if (morpheme.length > 20) {
      continue;
    }
    if (seen.has(morpheme)) {
      continue;
    }
    seen.add(morpheme);
    components.push({ morpheme, hint: cleanHint(match[2]) });
  }

  return components;
}

function cleanHint(raw: string): string {
  const hint = raw
    .replace(/[*`_~]/g, ' ')
    .replace(/→/g, ' ')
    .replace(/＋/g, ' ')
    .replace(/[\\[\](){}<>「」【】（）]/g, ' ')
    .replace(/\b[A-Za-z][A-Za-z'-]*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[+\-:：,，;；。、]+/, '')
    .replace(/[+\-:：,，;；。、]+$/, '');
  return hint;
}

export { cleanHint as cleanComponentHint };

/** Normalise a morpheme: lowercase, strips leading/trailing non-letters. */
export function normalizeMorpheme(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z]+$/, '');
}

/** Normalise an arbitrary JSON payload into a `DatasetFile`. */
export function normalizeDataset(raw: unknown): DatasetFile {
  if (!raw || typeof raw !== 'object') {
    return { meta: {}, roots: [], entries: [] };
  }
  const candidate = raw as DatasetFile & { words?: unknown };
  const entries = Array.isArray(candidate.entries) ? candidate.entries : [];
  const normalizedEntries = entries
    .filter((entry): entry is Entry => Boolean(entry) && typeof entry.word === 'string')
    .map((entry, index) => ({
      ...entry,
      id: entry.id || `e${index + 1}`,
      word: entry.word.toLowerCase(),
      meaning: entry.meaning ?? '',
      decomposition: entry.decomposition ?? '',
      components:
        Array.isArray(entry.components) && entry.components.length > 0
          ? entry.components
          : parseDecomposition(entry.decomposition ?? ''),
    }));

  const roots =
    Array.isArray(candidate.roots) && candidate.roots.length > 0
      ? candidate.roots
      : buildRoots(normalizedEntries);

  return {
    meta: { ...(candidate.meta ?? {}) },
    roots,
    entries: normalizedEntries,
  };
}

export function entryKey(entry: Entry): string {
  return `${entry.word}::${entry.meaning}::${entry.decomposition}`;
}

export interface MergeDatasetInput {
  id: string;
  label: string;
  dataset: DatasetFile;
}

export interface MergedDataset {
  dataset: DatasetFile;
  /** Per-source statistics, in input order. */
  sources: Array<{ id: string; label: string; entries: number; roots: number; generatedAt?: string }>;
}

/** Merge several datasets into one, de-duplicating identical entries. */
export function mergeDatasets(inputs: MergeDatasetInput[]): MergedDataset {
  const mergedEntries: Entry[] = [];
  const seen = new Set<string>();
  const sources: MergedDataset['sources'] = [];

  for (const input of inputs) {
    const entries = input.dataset.entries ?? [];
    let added = 0;
    for (const entry of entries) {
      const key = entryKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      added += 1;
      mergedEntries.push({ ...entry, source: entry.source ?? input.id });
    }
    sources.push({
      id: input.id,
      label: input.label,
      entries: added,
      roots: input.dataset.roots?.length ?? 0,
      generatedAt: input.dataset.meta?.generatedAt,
    });
  }

  const roots = buildRoots(mergedEntries);

  return {
    dataset: {
      meta: {
        entryCount: mergedEntries.length,
        rootCount: roots.length,
        generatedAt: new Date().toISOString(),
        sources: sources.map((source) => ({
          kind: 'dataset',
          id: source.id,
          label: source.label,
          entryCount: source.entries,
          generatedAt: source.generatedAt,
        })),
      },
      roots,
      entries: mergedEntries,
    },
    sources,
  };
}

export function buildRootToEntries(entries: Entry[]): Map<string, Entry[]> {
  const map = new Map<string, Entry[]>();
  for (const entry of entries) {
    for (const component of entry.components ?? []) {
      const root = component.morpheme;
      if (!root) {
        continue;
      }
      const list = map.get(root);
      if (list) {
        list.push(entry);
      } else {
        map.set(root, [entry]);
      }
    }
  }
  return map;
}
