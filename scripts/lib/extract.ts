import { buildRoots, cleanComponentHint, normalizeMorpheme, parseDecomposition } from '@/data/dataset';
import type { DatasetFile, Entry, RootComponent } from '@/types';

import type { ChatMessage, LlmConfig } from './llm';
import { chatJson } from './llm';

/**
 * Turns a raw share transcript into entries that match the shape used by
 * `public/data/roots_affixes.json`.
 *
 * The extraction itself is delegated to an OpenAI-compatible chat completion
 * (JSON mode), because the source transcripts are free-form explanations and
 * Markdown tables — heuristics choke on them, an LLM does not.
 */

export const SYSTEM_PROMPT = `你是一名英语词源与词根词缀数据工程师。你的任务是从用户提供的对话文本中抽取「英语单词 → 词根词缀拆解」数据，并严格按指定 JSON 结构输出。

抽取规则：
1. 只抽取文本中真实出现的英语单词，禁止臆造原文没有的单词。
2. 只输出可以拆解的单词（含有词根/前缀/后缀）。原文明确标注「不拆」「专有名词」的词请忽略。
3. word：小写，只含英文字母、连字符 - 和撇号 '，长度至少 2 个字符，不能含空格。
4. decomposition：用 " + " 连接各构词成分，保留原文的连字符写法，例如 "re- + solut- + -ion"、"over- + view"、"com- + pon- + -ent"。
5. components：按 decomposition 顺序逐个给出成分。morpheme 只保留英文字母并小写（去掉首尾连字符："re-" → "re"，"-ion" → "ion"）；hint 是该成分的中文含义，优先取原文说明，没有就填空字符串 ""。
6. meaning：该单词的简短中文释义，优先取原文，其次结合上下文给出不超过 8 个字的释义。
7. 同一个 word 只保留一条最完整的记录（成分最全、释义最完整）。
8. 只输出 JSON 对象，不要输出解释文字、不要使用 Markdown 代码块，禁止编造词源。

输出结构：
{"entries":[{"word":"resolution","meaning":"解决；分辨率","decomposition":"re- + solut- + -ion","components":[{"morpheme":"re","hint":"回、再"},{"morpheme":"solut","hint":"松开、解开"},{"morpheme":"ion","hint":"名词后缀"}]}]}

如果文本中没有可抽取的内容，返回 {"entries":[]}。`;

export function buildChunkMessages(chunk: string, index: number, total: number): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `以下是从 DeepSeek 分享对话中导出的原文片段（第 ${index + 1}/${total} 段）。\n` +
        '请按系统要求抽取词根词缀数据，只输出 JSON。\n\n' +
        '<<<SHARE_TRANSCRIPT\n' +
        chunk +
        '\nSHARE_TRANSCRIPT>>>',
    },
  ];
}

export interface RawEntry {
  word?: unknown;
  meaning?: unknown;
  decomposition?: unknown;
  components?: unknown;
}

export interface ExtractionStats {
  received: number;
  accepted: number;
  skipped: number;
  reasons: string[];
}

export interface NormalizeResult {
  entries: Entry[];
  stats: ExtractionStats;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[*`_~\s]/g, '')
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z'-]+$/, '');
}

function normalizeComponents(raw: unknown): RootComponent[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const components: RootComponent[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as { morpheme?: unknown; hint?: unknown };
    const morpheme = normalizeMorpheme(asString(candidate.morpheme));
    if (!morpheme || seen.has(morpheme)) {
      continue;
    }
    if (morpheme.length > 20 || (morpheme.length === 1 && morpheme !== 'a')) {
      continue;
    }
    seen.add(morpheme);
    components.push({ morpheme, hint: cleanComponentHint(asString(candidate.hint)) });
  }
  return components;
}

/** Validate and repair one LLM response into the app's entry shape. */
export function normalizeExtraction(
  raw: unknown,
  options: { source: string; idPrefix?: string } = { source: 'llm' },
): NormalizeResult {
  const list: RawEntry[] = Array.isArray((raw as { entries?: unknown })?.entries)
    ? ((raw as { entries: RawEntry[] }).entries)
    : [];

  const byWord = new Map<string, Entry>();
  const reasons: string[] = [];
  let skipped = 0;

  for (const candidate of list) {
    if (!candidate || typeof candidate !== 'object') {
      skipped += 1;
      continue;
    }
    const word = sanitizeWord(asString(candidate.word));
    if (!word || word.length < 2 || !/^[a-z][a-z'-]*$/.test(word)) {
      skipped += 1;
      reasons.push(`非法单词: ${asString(candidate.word) || '(空)'}`);
      continue;
    }

    let decomposition = asString(candidate.decomposition).replace(/\s*\+\s*/g, ' + ');
    const providedComponents = normalizeComponents(candidate.components);
    const looksSplit = /[+／/,;；]/.test(decomposition);

    if (!providedComponents.length && (!decomposition || !looksSplit)) {
      skipped += 1;
      reasons.push(`缺少拆解: ${word}`);
      continue;
    }

    let components = providedComponents;
    if (!components.length) {
      components = parseDecomposition(decomposition);
    }
    if (!components.length) {
      skipped += 1;
      reasons.push(`无法拆解: ${word}`);
      continue;
    }
    if (!decomposition) {
      decomposition = components.map((component) => component.morpheme).join(' + ');
    }

    const entry: Entry = {
      id: options.idPrefix ? `${options.idPrefix}-${word}` : word,
      word,
      meaning: asString(candidate.meaning).slice(0, 60),
      decomposition,
      components,
      source: options.source,
    };

    const existing = byWord.get(word);
    if (!existing || entry.components.length > existing.components.length) {
      byWord.set(word, entry);
    }
  }

  return {
    entries: [...byWord.values()],
    stats: { received: list.length, accepted: byWord.size, skipped, reasons: reasons.slice(0, 10) },
  };
}

export interface ExtractOptions {
  llm: LlmConfig;
  source: string;
  onProgress?: (message: string) => void;
}

/** Run the extraction over a list of transcript chunks and merge the results. */
export async function extractEntriesFromChunks(
  chunks: string[],
  options: ExtractOptions,
): Promise<{ entries: Entry[]; stats: ExtractionStats[] }> {
  const collected = new Map<string, Entry>();
  const stats: ExtractionStats[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    options.onProgress?.(`LLM 抽取第 ${index + 1}/${chunks.length} 段（${chunks[index].length} 字符）…`);
    const raw = await chatJson<unknown>(
      { ...options.llm, label: `LLM 抽取 ${index + 1}/${chunks.length}` },
      buildChunkMessages(chunks[index], index, chunks.length),
      {
        onRetry: (error) =>
          options.onProgress?.(`  ↳ JSON 解析失败（${error.message}），正在请求修复…`),
      },
    );

    const result = normalizeExtraction(raw, { source: options.source });
    stats.push(result.stats);
    for (const entry of result.entries) {
      const existing = collected.get(entry.word);
      if (!existing || entry.components.length > existing.components.length) {
        collected.set(entry.word, entry);
      }
    }
  }

  return {
    entries: [...collected.values()],
    stats,
  };
}

/** Build the final dataset payload (entries + roots identical in shape to the PDF output). */
export function buildDataset(
  entries: Entry[],
  meta: Record<string, unknown>,
): DatasetFile {
  const sorted = entries.slice().sort((a, b) => a.word.localeCompare(b.word));
  const withIds = sorted.map((entry, index) => ({ ...entry, id: `e${index + 1}` }));
  const roots = buildRoots(withIds);

  return {
    meta: {
      ...meta,
      generatedAt: new Date().toISOString(),
      entryCount: withIds.length,
      rootCount: roots.length,
    },
    roots,
    entries: withIds,
  };
}
