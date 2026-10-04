/**
 * Renders the whole app with Vite's SSR pipeline in plain Node, first with the
 * real dataset loaded from `public/` and then again with an empty store.
 *
 * This is a cheap smoke test: it executes every component's `setup()` and
 * template, so a broken template, a missing import or an undefined property
 * access fails loudly instead of only breaking in the browser.
 *
 *   npm run test:render
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { renderToString } from '@vue/server-renderer';
import { createSSRApp } from 'vue';
import { createServer } from 'vite';

// Serve `public/` over the global fetch so the dataset loader can run unchanged.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), 'http://localhost/');
  const file = path.join(process.cwd(), 'public', decodeURIComponent(url.pathname));
  if (!existsSync(file)) {
    return new Response('', { status: 404 });
  }
  const body = await readFile(file, 'utf8');
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

function assertIncludes(html: string, expectations: string[], label: string): void {
  const missing = expectations.filter((needle) => !html.includes(needle));
  if (missing.length) {
    throw new Error(`${label} 渲染结果缺少内容: ${missing.join(', ')}`);
  }
}

async function renderApp(): Promise<string> {
  const { default: App } = (await server.ssrLoadModule('/src/App.vue')) as { default: unknown };
  const app = createSSRApp(App as never);
  app.config.warnHandler = (message) => {
    throw new Error(`Vue warning: ${message}`);
  };
  return renderToString(app);
}

try {
  // 1) empty store
  const emptyHtml = await renderApp();
  assertIncludes(
    emptyHtml,
    [
      '词根词缀记忆工坊',
      '学习地图',
      '闪卡训练',
      '选择题',
      '云同步',
      'WebDAV',
      'Google Drive',
      'theme-toggle',
      '浅色',
      '深色',
      '跟随系统外观',
    ],
    '空数据',
  );
  console.log(`✅ 空数据渲染通过（${emptyHtml.length} 字符）`);

  // 2) with the real bundled dataset
  const dataset = (await server.ssrLoadModule('/src/stores/dataset.ts')) as {
    loadDataset: () => Promise<void>;
    datasetState: { entries: unknown[]; roots: unknown[] };
  };
  await dataset.loadDataset();
  if (dataset.datasetState.entries.length < 100) {
    throw new Error(`数据集加载异常，仅 ${dataset.datasetState.entries.length} 条`);
  }

  const html = await renderApp();
  assertIncludes(html, ['unreal', '已掌握', '正确率'], '全量数据');
  console.log(
    `✅ 全量数据渲染通过：${dataset.datasetState.entries.length} 词条 / ${dataset.datasetState.roots.length} 词根，输出 ${html.length} 字符`,
  );
} finally {
  globalThis.fetch = nativeFetch;
  await server.close();
}
