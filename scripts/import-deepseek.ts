#!/usr/bin/env node
/**
 * Import root/affix data from public DeepSeek share links.
 *
 *   npm run import:deepseek -- --share-id xt2cibe2byagd207uj
 *
 * Two stages:
 *   1. download the share content (browser-like headers + pacing + caching)
 *   2. ask an OpenAI-compatible chat completion to extract
 *      `word / meaning / decomposition / components` records, which are then
 *      validated, indexed and written next to the built-in dataset.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { normalizeDataset } from '@/data/dataset';
import type { DatasetFile, DatasetManifest, DatasetManifestItem, Entry } from '@/types';

import {
  DEFAULT_BASE_URL,
  chunkTranscript,
  fetchShare,
  normalizeShare,
  toTranscript,
  type DeepSeekShare,
} from './lib/deepseek';
import { buildDataset, extractEntriesFromChunks, type ExtractionStats } from './lib/extract';
import { BROWSER_PROFILES } from './lib/http';

const BROWSER_PROFILES_HINT = BROWSER_PROFILES.map((p) => p.name).join(' / ');

/** Default LLM target: DeepSeek's own OpenAI-compatible endpoint. */
const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_LLM_MODEL = 'deepseek-chat';

const HELP = `
从 DeepSeek 分享链接导入词根词缀数据

用法
  npm run import:deepseek -- --share-id <ID> [更多选项]

数据来源
  --share-id <id>        DeepSeek 分享 ID，可重复或逗号分隔（也可作为位置参数传入）
  --base-url <url>       分享站点地址，默认 ${DEFAULT_BASE_URL}
  --input <file>         直接读取本地已下载的分享 JSON（可重复，离线可用）

抓取伪装（反爬）
  --ua-profile <name>    UA 预设：${BROWSER_PROFILES_HINT}
  --user-agent <ua>      自定义 User-Agent（覆盖预设）
  --referer <url>        自定义 Referer，默认 https://chat.deepseek.com/share/<id>
  --cookie <cookie>      需要登录态时附加的 Cookie（或用环境变量 DEEPSEEK_COOKIE）
  --delay <ms>           每个分享请求前的最小等待，默认 800
  --jitter <ms>          随机抖动上限，默认 1200
  --retries <n>          请求重试次数，默认 3
  --timeout <ms>         单次请求超时，默认 20000
  --proxy <url>          通过代理请求（需要安装 undici）
  --cache-dir <dir>      原始分享内容缓存目录，默认 .import-cache
  --refresh              忽略缓存，重新下载

LLM 抽取（OpenAI 兼容接口）
  --model <name>         模型名，默认 OPENAI_MODEL 或 ${DEFAULT_LLM_MODEL}
  --llm-base-url <url>   OpenAI 兼容地址，默认 OPENAI_BASE_URL 或 ${DEFAULT_LLM_BASE_URL}
  --llm-api-key <key>    API Key，默认环境变量 OPENAI_API_KEY / DEEPSEEK_API_KEY
  --temperature <n>      采样温度，默认 0.2
  --max-tokens <n>       单次输出上限（默认不限制）
  --chunk-chars <n>      每个请求的原文长度上限，默认 6000
  --json-mode <mode>     auto | on | off，是否发送 response_format=json_object，默认 auto
  --include-user         把用户提问也纳入原文（默认只取助手回答）
  --include-thinking     把思考过程（THINK）也纳入原文

输出
  --out-dir <dir>        数据集输出目录，默认 public/data/datasets
  --id <id>              数据集 ID（文件名），默认 deepseek-<分享ID前8位>
  --label <text>         数据集显示名，默认取分享标题
  --append               与同 ID 的已有数据集合并后再写入
  --dry-run              只抽取不写文件
  --print                打印抽取结果

示例
  npm run import:deepseek -- --share-id xt2cibe2byagd207uj
  npm run import:deepseek -- --share-id xt2cibe2byagd207uj --model gpt-4o-mini --llm-base-url https://api.openai.com/v1
  npm run import:deepseek -- --share-id a1b2c3, d4e5f6 --id deepseek-roots --append
  npm run import:deepseek -- --input .import-cache/xt2cibe2byagd207uj.json --print
`;

interface CliOptions {
  shareIds: string[];
  inputs: string[];
  baseUrl: string;
  outDir: string;
  id: string;
  label: string;
  model: string;
  llmBaseUrl: string;
  llmApiKey: string;
  temperature: number;
  maxTokens?: number;
  chunkChars: number;
  jsonMode: 'auto' | 'on' | 'off';
  userAgent?: string;
  uaProfile?: string;
  referer?: string;
  cookie?: string;
  delay: number;
  jitter: number;
  retries: number;
  timeout: number;
  proxy?: string;
  cacheDir: string;
  refresh: boolean;
  includeUser: boolean;
  includeThinking: boolean;
  dryRun: boolean;
  append: boolean;
  print: boolean;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCli(): CliOptions | null {
  const { values, positionals } = parseArgs({
    options: {
      'share-id': { type: 'string', multiple: true },
      'base-url': { type: 'string' },
      input: { type: 'string', multiple: true },
      'out-dir': { type: 'string' },
      id: { type: 'string' },
      label: { type: 'string' },
      model: { type: 'string' },
      'llm-base-url': { type: 'string' },
      'llm-api-key': { type: 'string' },
      temperature: { type: 'string' },
      'max-tokens': { type: 'string' },
      'chunk-chars': { type: 'string' },
      'json-mode': { type: 'string' },
      'user-agent': { type: 'string' },
      'ua-profile': { type: 'string' },
      referer: { type: 'string' },
      cookie: { type: 'string' },
      delay: { type: 'string' },
      jitter: { type: 'string' },
      retries: { type: 'string' },
      timeout: { type: 'string' },
      proxy: { type: 'string' },
      'cache-dir': { type: 'string' },
      refresh: { type: 'boolean' },
      'include-user': { type: 'boolean' },
      'include-thinking': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      append: { type: 'boolean' },
      print: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP.trim());
    return null;
  }

  const shareIds = [
    ...(values['share-id'] ?? []).flatMap((value) => value.split(',')),
    ...positionals,
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  const inputs = values.input ?? [];

  if (!shareIds.length && !inputs.length) {
    console.error('❌ 需要至少一个 --share-id 或 --input\n');
    console.log(HELP.trim());
    process.exitCode = 1;
    return null;
  }

  const jsonModeRaw = (values['json-mode'] ?? 'auto').toLowerCase();
  const jsonMode = jsonModeRaw === 'on' || jsonModeRaw === 'off' ? jsonModeRaw : 'auto';
  const fallbackId = shareIds.length
    ? `deepseek-${shareIds[0].slice(0, 8)}`
    : `deepseek-${path.basename(inputs[0]).replace(/\.json$/i, '').slice(0, 8)}`;

  return {
    shareIds,
    inputs,
    baseUrl: values['base-url'] ?? DEFAULT_BASE_URL,
    outDir: values['out-dir'] ?? 'public/data/datasets',
    id: values.id ?? fallbackId,
    label: values.label ?? '',
    model: values.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    llmBaseUrl: values['llm-base-url'] ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    llmApiKey: values['llm-api-key'] ?? process.env.OPENAI_API_KEY ?? '',
    temperature: num(values.temperature, 0.2),
    maxTokens: values['max-tokens'] ? num(values['max-tokens'], 0) : undefined,
    chunkChars: num(values['chunk-chars'], 6_000),
    jsonMode,
    userAgent: values['user-agent'],
    uaProfile: values['ua-profile'],
    referer: values.referer,
    cookie: values.cookie ?? process.env.DEEPSEEK_COOKIE,
    delay: num(values.delay, 800),
    jitter: num(values.jitter, 1_200),
    retries: num(values.retries, 3),
    timeout: num(values.timeout, 20_000),
    proxy: values.proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy,
    cacheDir: values['cache-dir'] ?? '.import-cache',
    refresh: Boolean(values.refresh),
    includeUser: Boolean(values['include-user']),
    includeThinking: Boolean(values['include-thinking']),
    dryRun: Boolean(values['dry-run']),
    append: Boolean(values.append),
    print: Boolean(values.print),
  };
}

async function loadShareFromFile(file: string, baseUrl: string): Promise<DeepSeekShare> {
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed && typeof parsed === 'object' && 'messages' in parsed && 'shareId' in parsed) {
    return parsed as unknown as DeepSeekShare;
  }
  const shareId =
    (typeof parsed.share_id === 'string' && parsed.share_id) ||
    path.basename(file).replace(/\.json$/i, '');
  return normalizeShare(shareId, parsed, baseUrl);
}

async function loadShare(shareId: string, options: CliOptions): Promise<DeepSeekShare> {
  const cacheFile = path.join(options.cacheDir, `${shareId}.json`);
  if (!options.refresh && existsSync(cacheFile)) {
    console.log(`📦 使用缓存 ${cacheFile}`);
    return loadShareFromFile(cacheFile, options.baseUrl);
  }

  console.log(`🌐 下载分享内容 share_id=${shareId} …`);
  const share = await fetchShare(shareId, {
    baseUrl: options.baseUrl,
    referer: options.referer,
    userAgent: options.userAgent,
    uaProfile: options.uaProfile,
    cookie: options.cookie,
    minDelayMs: options.delay,
    maxDelayMs: options.jitter,
    retries: options.retries,
    timeoutMs: options.timeout,
    proxy: options.proxy,
  });

  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(share, null, 2), 'utf8');
  console.log(`   ↳ 标题「${share.title}」，共 ${share.messages.length} 条消息，已缓存到 ${cacheFile}`);
  return share;
}

function describeStats(stats: ExtractionStats[]): string {
  const received = stats.reduce((sum, item) => sum + item.received, 0);
  const accepted = stats.reduce((sum, item) => sum + item.accepted, 0);
  const skipped = stats.reduce((sum, item) => sum + item.skipped, 0);
  const reasons = [...new Set(stats.flatMap((item) => item.reasons))].slice(0, 8);
  return [
    `   LLM 返回 ${received} 条，采纳 ${accepted} 条，丢弃 ${skipped} 条`,
    ...reasons.map((reason) => `     · ${reason}`),
  ].join('\n');
}

async function readManifest(file: string): Promise<DatasetManifest> {
  if (!existsSync(file)) {
    return { datasets: [] };
  }
  try {
    return JSON.parse(await readFile(file, 'utf8')) as DatasetManifest;
  } catch {
    return { datasets: [] };
  }
}

async function main(): Promise<void> {
  const options = parseCli();
  if (!options) {
    return;
  }

  const datasetFile = path.join(options.outDir, `${options.id}.json`);
  const manifestFile = path.join(options.outDir, 'index.json');

  // ---------------------------------------------------------------- stage 1
  const shares: DeepSeekShare[] = [];
  for (const file of options.inputs) {
    console.log(`📄 读取本地分享文件 ${file}`);
    shares.push(await loadShareFromFile(file, options.baseUrl));
  }
  for (const shareId of options.shareIds) {
    shares.push(await loadShare(shareId, options));
  }

  const transcript = shares
    .map((share) =>
      toTranscript(share, {
        includeUserMessages: options.includeUser,
        includeThinking: options.includeThinking,
      }),
    )
    .join('\n\n')
    .trim();

  if (!transcript) {
    console.error('❌ 分享内容为空，没有可抽取的文本。');
    process.exitCode = 1;
    return;
  }

  const chunks = chunkTranscript(transcript, options.chunkChars);
  console.log(`📝 原文 ${transcript.length} 字符，切分为 ${chunks.length} 段交给 LLM 抽取`);

  // ---------------------------------------------------------------- stage 2
  if (!options.llmApiKey) {
    console.error(
      '❌ 缺少 LLM API Key：请设置 OPENAI_API_KEY 环境变量，或传入 --llm-api-key。',
    );
    process.exitCode = 1;
    return;
  }

  const source = `deepseek:${shares.map((share) => share.shareId).join(',')}`;
  const { entries, stats } = await extractEntriesFromChunks(chunks, {
    llm: {
      baseUrl: options.llmBaseUrl,
      apiKey: options.llmApiKey,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      timeoutMs: 180_000,
      retries: options.retries,
      jsonMode: options.jsonMode !== 'off',
    },
    source,
    onProgress: (message) => console.log(`🤖 ${message}`),
  });

  console.log('📊 抽取统计：');
  console.log(describeStats(stats));

  if (!entries.length) {
    console.error('❌ 没有抽取到任何词根词缀数据，未写入文件。');
    process.exitCode = 1;
    return;
  }

  // ---------------------------------------------------------------- merge
  let mergedEntries: Entry[] = entries;
  if (options.append && existsSync(datasetFile)) {
    const existing = normalizeDataset(JSON.parse(await readFile(datasetFile, 'utf8')) as unknown);
    const seen = new Set(entries.map((entry) => entry.word));
    const kept = (existing.entries ?? []).filter((entry) => !seen.has(entry.word));
    mergedEntries = [...kept, ...entries];
    console.log(`🔗 --append：保留已有 ${kept.length} 条，新增 ${entries.length} 条`);
  }

  const label =
    options.label ||
    (shares.length === 1 ? `${shares[0].title} · 词根拆解` : `DeepSeek 拆词 ${options.id}`);
  const dataset: DatasetFile = buildDataset(mergedEntries, {
    label,
    sourceKind: 'deepseek-share',
    model: options.model,
    sources: shares.map((share) => ({
      kind: 'deepseek-share',
      shareId: share.shareId,
      title: share.title,
      url: share.sourceUrl,
      messageCount: share.messages.length,
      fetchedAt: share.fetchedAt,
    })),
  });

  console.log(
    `✅ 生成数据集 ${options.id}：${dataset.entries?.length ?? 0} 个词条 / ${dataset.roots?.length ?? 0} 个词根`,
  );
  console.log(
    '   高频词根: ' +
      (dataset.roots ?? [])
        .slice(0, 8)
        .map((root) => `${root.root}(${root.wordCount})`)
        .join(', '),
  );

  if (options.print) {
    console.log(JSON.stringify(dataset, null, 2));
  }

  if (options.dryRun) {
    console.log('🚧 --dry-run：未写入任何文件。');
    return;
  }

  // ---------------------------------------------------------------- write
  await mkdir(options.outDir, { recursive: true });
  await writeFile(datasetFile, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');

  const manifest = await readManifest(manifestFile);
  const item: DatasetManifestItem = {
    id: options.id,
    label,
    file: `${options.id}.json`,
    entryCount: dataset.entries?.length ?? 0,
    rootCount: dataset.roots?.length ?? 0,
    generatedAt: String(dataset.meta?.generatedAt ?? new Date().toISOString()),
  };
  const datasets = (manifest.datasets ?? []).filter((entry) => entry.id !== item.id);
  datasets.push(item);
  datasets.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(
    manifestFile,
    `${JSON.stringify({ datasets }, null, 2)}\n`,
    'utf8',
  );

  console.log(`💾 已写入 ${datasetFile}`);
  console.log(`💾 已更新 ${manifestFile}`);
  console.log('ℹ️  运行 `npm run build` 后数据集会随站点一起发布（或直接在 dev 模式下查看）。');
}

main().catch((error: unknown) => {
  console.error('❌ 导入失败:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
