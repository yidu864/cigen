import './setup-browser-env';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { fakeExtraction, startFakeDeepSeek, startFakeLlm } from './fake-llm-server';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('import script downloads a share, sends disguise headers and writes a dataset', async (t) => {
  const share = await startFakeDeepSeek();
  const llm = await startFakeLlm(() => fakeExtraction());
  t.after(() => share.close());
  t.after(() => llm.close());

  const workDir = await mkdtemp(path.join(tmpdir(), 'cigen-import-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const outDir = path.join(workDir, 'datasets');
  const cacheDir = path.join(workDir, 'cache');

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/import-deepseek.ts',
      '--share-id',
      'xt2cibe2byagd207uj',
      '--base-url',
      share.url,
      '--llm-base-url',
      llm.url,
      '--llm-api-key',
      'test-key',
      '--model',
      'fake-model',
      '--out-dir',
      outDir,
      '--cache-dir',
      cacheDir,
      '--id',
      'deepseek-test',
      '--delay',
      '0',
      '--jitter',
      '0',
    ],
    { cwd: repoRoot, timeout: 120_000 },
  );

  assert.match(stdout, /生成数据集 deepseek-test/);

  // --- anti-crawl disguise -------------------------------------------------
  assert.equal(share.calls.length, 1);
  const call = share.calls[0];
  assert.equal(call.path, '/api/v0/share/content?share_id=xt2cibe2byagd207uj');
  const userAgent = String(call.headers['user-agent']);
  assert.match(userAgent, /Mozilla\/5\.0 .*Chrome\/131/);
  assert.equal(call.headers.referer, `${share.url}/share/xt2cibe2byagd207uj`);
  assert.equal(call.headers.origin, share.url);
  assert.equal(call.headers['sec-fetch-site'], 'same-origin');
  assert.equal(call.headers['accept-language']?.toString().startsWith('zh-CN'), true);

  // --- LLM request uses the OpenAI format ---------------------------------
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].path, '/v1/chat/completions');
  assert.equal(String(llm.calls[0].headers.authorization), 'Bearer test-key');
  const body = llm.calls[0].body as {
    model: string;
    response_format?: { type: string };
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, 'fake-model');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /词根词缀/);
  assert.match(body.messages[1].content, /resolution = re- \+ solut- \+ -ion/);

  // --- written dataset ----------------------------------------------------
  const dataset = JSON.parse(
    await readFile(path.join(outDir, 'deepseek-test.json'), 'utf8'),
  ) as {
    meta: { entryCount: number; rootCount: number; sources: Array<{ shareId: string }> };
    entries: Array<{ word: string; decomposition: string; components: Array<{ morpheme: string; hint: string }> }>;
    roots: Array<{ root: string; gloss: string; wordCount: number }>;
  };

  assert.deepEqual(dataset.entries.map((entry) => entry.word), ['compatible', 'resolution']);
  assert.equal(dataset.meta.entryCount, 2);
  assert.equal(dataset.meta.sources[0].shareId, 'xt2cibe2byagd207uj');

  const resolution = dataset.entries.find((entry) => entry.word === 'resolution');
  assert.ok(resolution);
  assert.equal(resolution.decomposition, 're- + solut- + -ion');
  assert.deepEqual(
    resolution.components.map((component) => component.morpheme),
    ['re', 'solut', 'ion'],
  );
  assert.equal(resolution.components[1].hint, '松开、解开');

  assert.equal(existsSync(path.join(outDir, 'index.json')), true);
  const manifest = JSON.parse(await readFile(path.join(outDir, 'index.json'), 'utf8')) as {
    datasets: Array<{ id: string; label: string; file: string; entryCount: number; rootCount: number }>;
  };
  assert.equal(manifest.datasets.length, 1);
  assert.equal(manifest.datasets[0].id, 'deepseek-test');
  assert.equal(manifest.datasets[0].file, 'deepseek-test.json');
  assert.equal(manifest.datasets[0].entryCount, 2);
  assert.equal(manifest.datasets[0].rootCount, dataset.roots.length);
  assert.equal(manifest.datasets[0].label, '词根拆解测试 · 词根拆解');

  // --- cache reuse --------------------------------------------------------
  const cached = JSON.parse(
    await readFile(path.join(cacheDir, 'xt2cibe2byagd207uj.json'), 'utf8'),
  ) as { title: string; sourceUrl: string };
  assert.equal(cached.title, '词根拆解测试');
  assert.match(cached.sourceUrl, /\/share\/xt2cibe2byagd207uj$/);
});
