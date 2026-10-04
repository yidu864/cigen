import './setup-dom-env';

import assert from 'node:assert/strict';
import test from 'node:test';

/** A minimal but realistic DeepSeek-import style payload. */
function samplePayload(): unknown {
  return {
    meta: { label: 'DeepSeek 拆词', sourceKind: 'deepseek-share' },
    entries: [
      {
        id: 'e1',
        word: 'resolution',
        meaning: '解决；分辨率',
        decomposition: 're- + solut- + -ion',
        components: [
          { morpheme: 're', hint: '回、再' },
          { morpheme: 'solut', hint: '松开、解开' },
          { morpheme: 'ion', hint: '名词后缀' },
        ],
      },
      {
        id: 'e2',
        word: 'resolute',
        meaning: '坚决的',
        decomposition: 're- + solut- + -e',
        components: [
          { morpheme: 're', hint: '回、再' },
          { morpheme: 'solut', hint: '松开、解开' },
        ],
      },
    ],
  };
}

test('importing a local dataset registers it, indexes its roots and persists it', async () => {
  const storage = globalThis.localStorage as Storage;
  storage.clear();

  const store = await import('@/stores/dataset');
  const localStore = await import('@/data/localStore');

  assert.equal(store.datasetState.sources.length, 0);

  const summary = await store.importDataset({
    raw: samplePayload(),
    filename: 'deepseek-roots.json',
  });

  assert.equal(summary.id, 'deepseek-roots');
  assert.equal(summary.label, 'DeepSeek 拆词');
  assert.equal(summary.entries, 2);
  assert.deepEqual(summary.preview, ['resolution', 'resolute']);
  assert.equal(summary.overlap, 0);

  // Registered, enabled and merged into the working set.
  const source = store.datasetState.sources.find((item) => item.id === 'deepseek-roots');
  assert.ok(source);
  assert.equal(source.kind, 'imported');
  assert.equal(store.datasetState.activeSourceIds.includes('deepseek-roots'), true);
  assert.deepEqual(
    store.datasetState.entries.map((entry) => entry.word),
    ['resolution', 'resolute'],
  );

  // Roots are recomputed from the entries, so the study map/quiz work with it.
  const solut = store.datasetState.roots.find((root) => root.root === 'solut');
  assert.ok(solut, 'expected the `solut` root in the rebuilt index');
  assert.equal(solut.wordCount, 2);
  assert.equal(solut.gloss, '松开、解开');
  assert.deepEqual(solut.sampleWords, ['resolution', 'resolute']);

  // Persisted for the next visit.
  const stored = await localStore.listStoredDatasets();
  assert.deepEqual(stored.map((item) => item.id), ['deepseek-roots']);
  assert.equal(stored[0].dataset.entries?.length, 2);

  // A second import of the same file replaces the previous copy: that is what
  // you want after regenerating a dataset with the import script.
  const again = await store.importDataset({ raw: samplePayload(), filename: 'deepseek-roots.json' });
  assert.equal(again.id, 'deepseek-roots');
  assert.equal(store.datasetState.sources.length, 1);
  assert.equal((await localStore.listStoredDatasets()).length, 1);

  // Disabling removes it from the working set without deleting it.
  store.setSourceEnabled('deepseek-roots', false);
  assert.equal(store.datasetState.entries.length, 0);
  assert.equal(store.datasetState.activeSourceIds.includes('deepseek-roots'), false);

  store.setSourceEnabled('deepseek-roots', true);
  assert.equal(store.datasetState.entries.length, 2);

  // A *different* file with a different name gets its own id.
  const other = await store.importDataset({
    raw: samplePayload(),
    filename: 'deepseek-roots-v2.json',
  });
  assert.equal(other.id, 'deepseek-roots-v2');
  assert.equal(store.datasetState.sources.length, 2);

  // Removing deletes source + stored copy.
  await store.removeSource('deepseek-roots');
  assert.equal(
    store.datasetState.sources.some((item) => item.id === 'deepseek-roots'),
    false,
  );
  assert.deepEqual(
    (await localStore.listStoredDatasets()).map((item) => item.id),
    ['deepseek-roots-v2'],
  );

  await store.removeSource('deepseek-roots-v2');
  assert.deepEqual(await localStore.listStoredDatasets(), []);
});

test('importing accepts a bare entry array and rejects unusable payloads', async () => {
  const store = await import('@/stores/dataset');

  // The LLM extraction output shape (`{entries: [...]}`) and a bare array.
  const summary = await store.importDataset({
    raw: [{ word: 'overview', meaning: '概览', decomposition: 'over- + view' }],
    label: '裸数组',
    persist: false,
  });
  assert.equal(summary.entries, 1);
  assert.equal(summary.label, '裸数组');
  assert.ok(store.datasetState.roots.some((root) => root.root === 'view'));

  await assert.rejects(
    () => store.importDataset({ raw: { hello: 'world' }, persist: false }),
    /没有可用的词条/,
  );
  await assert.rejects(() => store.importDataset({ raw: [], persist: false }), /没有可用的词条/);

  // Entries without any word are dropped, so the whole payload is unusable.
  await assert.rejects(
    () => store.importDataset({ raw: { entries: [{ meaning: '没有单词' }] }, persist: false }),
    /没有可用的词条/,
  );
});
