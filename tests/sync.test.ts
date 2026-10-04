import './setup-browser-env';

import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeProgress, normalizeProgress } from '@/data/progress';
import { SyncManager, SYNC_MODULE } from '@/sync/manager';
import { normalizeCollectionUrl } from '@/sync/webdav';
import { startFakeWebDav } from './fake-webdav-server';

/** Absolute path prefix used by the fake server's storage map. */
const MODULE_PREFIX = `/dav/cigen/${SYNC_MODULE}/`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await sleep(25);
  }
  return predicate();
}

test('normalizeCollectionUrl keeps the origin and forces a trailing slash', () => {
  assert.equal(
    normalizeCollectionUrl('https://dav.example.com/remote.php/dav/files/me/cigen'),
    'https://dav.example.com/remote.php/dav/files/me/cigen/',
  );
  assert.equal(normalizeCollectionUrl('https://dav.example.com/a/'), 'https://dav.example.com/a/');
  assert.throws(() => normalizeCollectionUrl('dav.example.com/x'));
});

test('WebDAV backend runs a full remoteStorage.js sync cycle', async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());

  const logs: string[] = [];
  const manager = new SyncManager({
    fetchImpl: fetch,
    onLog: (entry) => logs.push(`${entry.level}:${entry.message}`),
  });

  await manager.connectWebDav({ url: server.url, username: 'tester', password: 'secret' });
  assert.equal(manager.state.connected, true);
  assert.equal(await waitFor(() => manager.state.connected), true);

  // --- progress round trip ------------------------------------------------
  const progress = normalizeProgress({
    mastered: { trans: true, port: true },
    quizCorrect: 3,
    quizTotal: 4,
    flashSeen: 7,
  });
  await manager.writeProgress(progress);

  assert.equal(await manager.syncNow(), true, `sync did not complete: ${logs.join(' | ')}`);

  const progressPath = `${MODULE_PREFIX}progress.json`;
  const stored = server.files.get(progressPath);
  assert.ok(
    stored,
    `expected ${progressPath} on the server, got ${[...server.files.keys()].join(',')}`,
  );

  const uploaded = JSON.parse(stored.body) as {
    mastered: Record<string, boolean>;
    quizCorrect: number;
  };
  assert.deepEqual(Object.keys(uploaded.mastered).sort(), ['port', 'trans']);
  assert.equal(uploaded.quizCorrect, 3);
  assert.equal(
    server.requests.some((request) => request.method === 'PROPFIND'),
    true,
  );
  assert.equal(
    server.requests.some((request) => request.method === 'MKCOL'),
    true,
  );

  // --- datasets -----------------------------------------------------------
  const datasetPath = `${MODULE_PREFIX}datasets/deepseek-roots.json`;
  await manager.writeDataset('deepseek-roots.json', {
    meta: { label: 'DeepSeek 拆词' },
    entries: [{ id: 'e1', word: 'overview', meaning: '概览', decomposition: 'over- + view' }],
  });
  assert.equal(await manager.syncNow(), true);
  assert.equal(await waitFor(() => server.files.has(datasetPath)), true);

  const listing = await manager.listDatasets();
  assert.deepEqual(listing, ['deepseek-roots.json']);

  const pulled = await manager.readDataset('deepseek-roots.json');
  assert.equal(pulled?.meta?.label, 'DeepSeek 拆词');
  assert.equal(pulled?.entries?.[0]?.word, 'overview');

  // --- deletion propagates ------------------------------------------------
  await manager.deleteDataset('deepseek-roots.json');
  assert.equal(await manager.syncNow(), true);
  assert.equal(server.files.has(datasetPath), false);

  manager.disconnect();
});

test('mergeProgress unions mastered roots and keeps the largest counters', () => {
  const local = normalizeProgress({
    mastered: { trans: true },
    quizCorrect: 5,
    quizTotal: 9,
    flashSeen: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const remote = normalizeProgress({
    mastered: { port: true },
    quizCorrect: 2,
    quizTotal: 20,
    flashSeen: 11,
    updatedAt: '2026-02-01T00:00:00.000Z',
  });

  const merged = mergeProgress(local, remote);
  assert.deepEqual(Object.keys(merged.mastered).sort(), ['port', 'trans']);
  assert.equal(merged.quizCorrect, 5);
  assert.equal(merged.quizTotal, 20);
  assert.equal(merged.flashSeen, 11);
  assert.equal(merged.updatedAt, '2026-02-01T00:00:00.000Z');

  assert.deepEqual(mergeProgress(local, null), local);
});
