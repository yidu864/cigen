<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  BASE_DATASET_ID,
  datasetState,
  importDataset,
  removeSource,
  setSourceEnabled,
  sourceStats,
  type DatasetSourceKind,
} from '@/stores/dataset';
import {
  deleteRemoteDataset,
  pullDataset,
  remoteDatasetFiles,
  refreshRemoteDatasets,
  syncState,
  uploadDataset,
} from '@/stores/sync';

const busy = ref(false);
const message = ref('');
const errorMessage = ref('');
const dragging = ref(false);
const showPaste = ref(false);
const pasteText = ref('');
const urlInput = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

const MAX_FILE_BYTES = 20 * 1024 * 1024;

const kindLabels: Record<DatasetSourceKind, string> = {
  bundled: '内置',
  imported: '本地导入',
  remote: '云端',
};

const statById = computed(() => {
  const map = new Map<string, { entries: number; roots: number }>();
  for (const stat of sourceStats.value) {
    map.set(stat.id, { entries: stat.entries, roots: stat.roots });
  }
  return map;
});

const remoteRows = computed(() =>
  remoteDatasetFiles.value.map((file) => {
    const id = file.replace(/\.json$/, '');
    return { file, id, loaded: datasetState.sources.some((source) => source.id === id) };
  }),
);

async function run(action: () => Promise<unknown>, success?: string): Promise<void> {
  busy.value = true;
  errorMessage.value = '';
  message.value = '';
  try {
    await action();
    if (success) {
      message.value = success;
    }
  } catch (error) {
    errorMessage.value = String((error as Error)?.message ?? error);
  } finally {
    busy.value = false;
  }
}

function describe(summary: { label: string; entries: number; roots: number; preview: string[]; overlap: number }): string {
  const parts = [
    `已导入并启用「${summary.label}」：${summary.entries} 个词条 / ${summary.roots} 个词根`,
  ];
  if (summary.preview.length) {
    parts.push(`示例：${summary.preview.join('、')}`);
  }
  if (summary.overlap > 0) {
    parts.push(`其中 ${summary.overlap} 条与其他数据集重复（会自动去重）`);
  }
  parts.push('可切换到「学习地图」搜索这些词');
  return parts.join(' · ');
}

async function readFile(file: File): Promise<void> {
  errorMessage.value = '';
  message.value = '';
  if (file.size > MAX_FILE_BYTES) {
    errorMessage.value = `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 20 MB。`;
    return;
  }
  busy.value = true;
  try {
    const text = await file.text();
    const raw = JSON.parse(text) as unknown;
    const summary = await importDataset({ raw, filename: file.name });
    message.value = describe(summary);
  } catch (error) {
    errorMessage.value =
      error instanceof SyntaxError
        ? `不是合法的 JSON 文件：${error.message}`
        : String((error as Error)?.message ?? error);
  } finally {
    busy.value = false;
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    void readFile(file);
  }
  input.value = '';
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    void readFile(file);
  }
}

function importFromPaste(): void {
  void run(async () => {
    const raw = JSON.parse(pasteText.value) as unknown;
    const summary = await importDataset({ raw, filename: `pasted-${Date.now()}.json` });
    pasteText.value = '';
    showPaste.value = false;
    message.value = describe(summary);
  }, '');
}

async function importFromUrl(): Promise<void> {
  await run(async () => {
    const url = urlInput.value.trim();
    if (!url) {
      throw new Error('请填写数据集 URL');
    }
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}（远端需要允许跨域 CORS）`);
    }
    const raw = (await response.json()) as unknown;
    const filename = url.split('/').pop()?.split('?')[0] || 'dataset.json';
    const summary = await importDataset({ raw, filename });
    urlInput.value = '';
    message.value = describe(summary);
  }, '');
}

function onUploadToCloud(id: string): void {
  const source = datasetState.sources.find((item) => item.id === id);
  if (!source) {
    return;
  }
  void run(() => uploadDataset(source), `已上传 ${source.label} 到云端（记得「立即同步」）`);
}

function onPull(file: string): void {
  void run(() => pullDataset(file), `已拉取 ${file}`);
}

function onDeleteRemote(file: string): void {
  if (!window.confirm(`确定要删除云端数据集 ${file} 吗？`)) {
    return;
  }
  void run(() => deleteRemoteDataset(file), `已删除 ${file}`);
}

function onRemoveSource(id: string, label: string): void {
  if (!window.confirm(`确定要移除数据集「${label}」吗？本地导入的数据会一并删除。`)) {
    return;
  }
  void run(() => removeSource(id), `已移除 ${label}`);
}
</script>

<template>
  <div class="sync-wrap">
    <section class="sync-card">
      <h3>导入本地数据集</h3>
      <p class="hint">
        支持 <code>npm run import:deepseek</code> 生成的
        <code>public/data/datasets/*.json</code>，也支持只包含
        <code>{ "entries": [ { "word": …, "decomposition": … } ] }</code> 的简写文件。
        导入的数据保存在浏览器 IndexedDB 中，刷新后依然可用。
      </p>

      <div
        class="dropzone"
        :class="{ dragging }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
        @click="fileInput?.click()"
      >
        <strong>把 JSON 文件拖到这里</strong>
        <span class="hint">或点击选择文件（.json，最大 20 MB）</span>
        <input
          ref="fileInput"
          class="visually-hidden"
          type="file"
          accept=".json,application/json"
          @change="onFileChange"
        />
      </div>

      <div class="sync-actions" style="margin-top: 10px">
        <button :disabled="busy" @click="fileInput?.click()">选择文件</button>
        <button class="ghost" :disabled="busy" @click="showPaste = !showPaste">
          {{ showPaste ? '收起粘贴框' : '粘贴 JSON' }}
        </button>
      </div>

      <div v-if="showPaste" style="margin-top: 12px">
        <div class="field">
          <label for="dataset-paste">粘贴数据集 JSON</label>
          <textarea
            id="dataset-paste"
            v-model="pasteText"
            placeholder='{"entries":[{"word":"resolution","meaning":"解决","decomposition":"re- + solut- + -ion"}]}'
          />
        </div>
        <button class="primary" :disabled="busy || !pasteText.trim()" @click="importFromPaste">
          导入粘贴内容
        </button>
      </div>

      <div class="field-row" style="margin-top: 14px; align-items: end">
        <div class="field" style="margin-bottom: 0">
          <label for="dataset-url">或从 URL 导入（需允许跨域）</label>
          <input
            id="dataset-url"
            v-model.trim="urlInput"
            type="url"
            placeholder="https://example.com/datasets/deepseek-roots.json"
          />
        </div>
        <button :disabled="busy || !urlInput" @click="importFromUrl">从 URL 导入</button>
      </div>

      <p v-if="errorMessage" class="hint" style="color: var(--bad); margin-bottom: 0">
        {{ errorMessage }}
      </p>
      <p v-else-if="message" class="hint" style="color: var(--ok); margin-bottom: 0">
        {{ message }}
      </p>
    </section>

    <section class="sync-card">
      <h3>已加载的数据集</h3>
      <p class="hint">点击开关可临时停用某个数据集；所有启用数据集会合并展示，重复词条自动去重。</p>

      <div class="dataset-list">
        <div v-for="source in datasetState.sources" :key="source.id" class="dataset-row">
          <div>
            <strong>{{ source.label }}</strong>
            <div class="meta">
              <span class="chip kind">{{ kindLabels[source.kind] }}</span>
              {{ statById.get(source.id)?.entries ?? 0 }} 词条 ·
              {{ statById.get(source.id)?.roots ?? 0 }} 词根
              <template v-if="source.file"> · {{ source.file }}</template>
              <template v-if="!datasetState.activeSourceIds.includes(source.id)"> · 已停用</template>
            </div>
          </div>
          <div class="sync-actions">
            <button
              :disabled="busy || source.id === BASE_DATASET_ID"
              :title="source.id === BASE_DATASET_ID ? '内置数据集始终启用' : ''"
              @click="setSourceEnabled(source.id, !datasetState.activeSourceIds.includes(source.id))"
            >
              {{ datasetState.activeSourceIds.includes(source.id) ? '停用' : '启用' }}
            </button>
            <button
              :disabled="busy || !syncState.connected"
              :title="syncState.connected ? '' : '需要先连接同步后端'"
              @click="onUploadToCloud(source.id)"
            >
              上传到云端
            </button>
            <button
              v-if="source.kind !== 'bundled'"
              class="danger"
              :disabled="busy"
              @click="onRemoveSource(source.id, source.label)"
            >
              移除
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="sync-card">
      <h3>云端数据集</h3>
      <p class="hint">从同步后端拉取数据集 JSON，拉取后同样保存在本地浏览器中。</p>
      <div v-if="!syncState.connected" class="hint">尚未连接同步后端。</div>
      <template v-else>
        <div class="sync-actions">
          <button :disabled="busy" @click="run(refreshRemoteDatasets, '已刷新云端数据集列表')">
            刷新列表
          </button>
        </div>
        <div v-if="!remoteRows.length" class="hint">云端还没有数据集文件。</div>
        <div v-else class="dataset-list">
          <div v-for="item in remoteRows" :key="item.file" class="dataset-row">
            <div>
              <strong>{{ item.id }}</strong>
              <div class="meta">{{ item.file }}{{ item.loaded ? ' · 已加载' : '' }}</div>
            </div>
            <div class="sync-actions">
              <button :disabled="busy" @click="onPull(item.file)">
                {{ item.loaded ? '重新拉取' : '拉取' }}
              </button>
              <button class="danger" :disabled="busy" @click="onDeleteRemote(item.file)">删除</button>
            </div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>
