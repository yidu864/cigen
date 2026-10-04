<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  bundledSources,
  datasetState,
  removeRemoteSource,
  setSourceEnabled,
  type DatasetSource,
} from '@/stores/dataset';
import {
  exportProgressJson,
  importProgressJson,
  masteredCount,
  progress,
  resetProgress,
} from '@/stores/progress';
import {
  clearLogs,
  connect,
  deleteRemoteDataset,
  disconnect,
  pullDataset,
  pushProgressNow,
  remoteDatasetFiles,
  refreshRemoteDatasets,
  setBackend,
  syncConfig,
  syncLogs,
  syncNow,
  syncState,
  uploadDataset,
} from '@/stores/sync';
import type { SyncBackend } from '@/types';

const busy = ref(false);
const message = ref('');
const errorMessage = ref('');
const importText = ref('');

const backends: Array<{ id: SyncBackend; title: string; desc: string }> = [
  {
    id: 'webdav',
    title: 'WebDAV',
    desc: 'Nextcloud / ownCloud / 坚果云 / Box 等任意 WebDAV 目录',
  },
  {
    id: 'googledrive',
    title: 'Google Drive (Google Cloud)',
    desc: '使用 Google OAuth 客户端 ID，把 JSON 存在 Google Drive 的 remotestorage 目录',
  },
  {
    id: 'remotestorage',
    title: 'remoteStorage 服务器',
    desc: 'remoteStorage.js 原生协议，需要 user@host 账号',
  },
];

const statusLabel = computed(() => {
  if (busy.value) {
    return '正在同步…';
  }
  if (syncState.connected) {
    return syncState.online ? '已连接' : '已连接（离线）';
  }
  return '未连接';
});

const statusClass = computed(() => {
  if (busy.value || syncState.busy) {
    return 'busy';
  }
  if (syncState.connected) {
    return 'connected';
  }
  if (syncState.lastError) {
    return 'error';
  }
  return '';
});

const lastSyncText = computed(() =>
  syncState.lastSyncAt ? new Date(syncState.lastSyncAt).toLocaleString() : '尚未同步',
);

const remoteDatasetLabels = computed(() =>
  remoteDatasetFiles.value.map((file) => {
    const id = file.replace(/\.json$/, '');
    return { file, id, loaded: datasetState.sources.some((source) => source.id === id) };
  }),
);

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

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

function onConnect(): void {
  errorMessage.value = '';
  message.value = '';
  void run(
    () => connect(),
    syncConfig.backend === 'webdav'
      ? 'WebDAV 已连接'
      : '正在跳转授权，请在授权页面确认后返回本站',
  );
}

function onDisconnect(): void {
  disconnect();
  message.value = '已断开连接';
}

function onUpload(source: DatasetSource): void {
  void run(() => uploadDataset(source), `已上传 ${source.label}`);
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

function downloadProgress(): void {
  const blob = new Blob([exportProgressJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `cigen-progress-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function applyImportedProgress(): void {
  try {
    importProgressJson(importText.value);
    message.value = '进度已导入';
    errorMessage.value = '';
  } catch (error) {
    errorMessage.value = `导入失败: ${String((error as Error).message)}`;
  }
}

function confirmReset(): void {
  if (window.confirm('确定要清空本地学习进度吗？该操作不可撤销。')) {
    resetProgress();
    message.value = '本地进度已清空';
  }
}
</script>

<template>
  <div class="sync-wrap">
    <section class="sync-card">
      <h3>同步状态</h3>
      <div class="status-line">
        <span class="dot" :class="statusClass"></span>
        <strong>{{ statusLabel }}</strong>
        <span class="chip">{{ syncConfig.backend }}</span>
        <span v-if="syncState.userAddress" class="chip">{{ syncState.userAddress }}</span>
        <span class="chip">最近同步: {{ lastSyncText }}</span>
        <span class="chip">本地已掌握 {{ masteredCount() }}</span>
      </div>

      <div class="sync-actions">
        <button class="primary" :disabled="busy || !syncState.connected" @click="run(syncNow, '同步完成')">
          立即同步
        </button>
        <button :disabled="busy || !syncState.connected" @click="run(pushProgressNow, '进度已推送')">
          推送进度
        </button>
        <button :disabled="busy || !syncState.connected" @click="run(refreshRemoteDatasets)">
          刷新云端数据集
        </button>
        <button v-if="syncState.connected" class="danger" :disabled="busy" @click="onDisconnect">
          断开连接
        </button>
      </div>

      <p v-if="errorMessage" class="hint" style="color: var(--bad); margin-bottom: 0">
        {{ errorMessage }}
      </p>
      <p v-else-if="message" class="hint" style="margin-bottom: 0">{{ message }}</p>
      <p v-if="syncState.lastError" class="hint" style="color: var(--warn)">
        最近错误：{{ syncState.lastError }}
      </p>
    </section>

    <section class="sync-card">
      <h3>选择同步后端</h3>
      <div class="backend-picker">
        <button
          v-for="backend in backends"
          :key="backend.id"
          class="backend-option"
          :class="{ active: syncConfig.backend === backend.id }"
          :disabled="busy"
          @click="setBackend(backend.id)"
        >
          <strong>{{ backend.title }}</strong>
          <span>{{ backend.desc }}</span>
        </button>
      </div>

      <template v-if="syncConfig.backend === 'webdav'">
        <div class="field">
          <label for="webdav-url">WebDAV 目录地址</label>
          <input
            id="webdav-url"
            v-model.trim="syncConfig.webdav.url"
            type="url"
            placeholder="https://dav.jianguoyun.com/dav/cigen/"
          />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="webdav-user">用户名</label>
            <input id="webdav-user" v-model.trim="syncConfig.webdav.username" type="text" autocomplete="username" />
          </div>
          <div class="field">
            <label for="webdav-pass">密码 / 应用密码</label>
            <input
              id="webdav-pass"
              v-model="syncConfig.webdav.password"
              type="password"
              autocomplete="current-password"
            />
          </div>
        </div>
        <label class="switch" style="margin-bottom: 10px">
          <input v-model="syncConfig.rememberPassword" type="checkbox" />
          在本机记住密码（关闭时仅保存在当前标签页会话）
        </label>
        <p class="hint">
          需要服务器允许跨域访问（CORS），且允许 <code>PROPFIND</code> / <code>MKCOL</code> 方法。
          Nextcloud 可在 <code>config.php</code> 中设置
          <code>'cors.allowed-domains' =&gt; ['https://你的用户名.github.io']</code>；
          坚果云等公共 WebDAV 若未开放 CORS，浏览器会拦截请求。
        </p>
      </template>

      <template v-else-if="syncConfig.backend === 'googledrive'">
        <div class="field">
          <label for="gdrive-client">Google OAuth 客户端 ID</label>
          <input
            id="gdrive-client"
            v-model.trim="syncConfig.googledrive.clientId"
            type="text"
            placeholder="xxxxxxxx.apps.googleusercontent.com"
          />
        </div>
        <p class="hint">
          在 Google Cloud Console 创建「OAuth 2.0 客户端 ID（Web 应用）」，把本站完整地址加入
          <strong>已获授权的重定向 URI</strong>，例如
          <code>https://yidu864.github.io/cigen/</code>，并启用 Google Drive API。
          授权范围仅限 Google Drive 文件，数据保存在 Drive 的
          <code>remotestorage/cigen/</code> 目录中。
        </p>
      </template>

      <template v-else>
        <div class="field">
          <label for="rs-address">remoteStorage 账号</label>
          <input
            id="rs-address"
            v-model.trim="syncConfig.remotestorage.userAddress"
            type="text"
            placeholder="user@5apps.com"
          />
        </div>
        <p class="hint">
          使用 remoteStorage 协议的托管服务（例如 5apps、armadietto 自建实例）。点击连接后会跳转到
          服务商页面完成授权，返回后自动开始同步。
        </p>
      </template>

      <div class="sync-actions" style="margin-top: 12px">
        <button class="primary" :disabled="busy" @click="onConnect">
          {{ syncState.connected ? '重新连接' : '连接并同步' }}
        </button>
      </div>
    </section>

    <section class="sync-card">
      <h3>词根数据集（JSON 文件）</h3>
      <p class="hint">
        本地数据集可以上传到云端，也可以把其他设备用
        <code>npm run import:deepseek</code> 生成的数据集拉取到当前设备。
      </p>

      <div class="dataset-list">
        <div v-for="source in bundledSources()" :key="source.id" class="dataset-row">
          <div>
            <strong>{{ source.label }}</strong>
            <div class="meta">
              {{ source.dataset.entries?.length ?? 0 }} 词条 ·
              {{ source.dataset.roots?.length ?? 0 }} 词根 ·
              {{ datasetState.activeSourceIds.includes(source.id) ? '已启用' : '未启用' }}
            </div>
          </div>
          <div class="sync-actions">
            <button
              :disabled="busy"
              @click="setSourceEnabled(source.id, !datasetState.activeSourceIds.includes(source.id))"
            >
              {{ datasetState.activeSourceIds.includes(source.id) ? '停用' : '启用' }}
            </button>
            <button
              :disabled="busy || !syncState.connected || source.id === 'base'"
              :title="source.id === 'base' ? '内置数据集体积较大，默认不上传' : ''"
              @click="onUpload(source)"
            >
              上传到云端
            </button>
          </div>
        </div>
      </div>

      <h3 style="margin-top: 16px">云端数据集</h3>
      <div v-if="!syncState.connected" class="hint">连接后可查看云端数据集。</div>
      <div v-else-if="!remoteDatasetLabels.length" class="hint">云端还没有数据集文件。</div>
      <div v-else class="dataset-list">
        <div v-for="item in remoteDatasetLabels" :key="item.file" class="dataset-row">
          <div>
            <strong>{{ item.id }}</strong>
            <div class="meta">{{ item.file }}{{ item.loaded ? ' · 已加载' : '' }}</div>
          </div>
          <div class="sync-actions">
            <button :disabled="busy" @click="onPull(item.file)">拉取</button>
            <button
              class="danger"
              :disabled="busy"
              @click="onDeleteRemote(item.file)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
      <div v-if="datasetState.sources.some((s) => s.kind === 'remote')" class="sync-actions" style="margin-top: 10px">
        <button
          v-for="source in datasetState.sources.filter((s) => s.kind === 'remote')"
          :key="source.id"
          class="ghost"
          :disabled="busy"
          @click="removeRemoteSource(source.id)"
        >
          移除本地加载的 {{ source.id }}
        </button>
      </div>
    </section>

    <section class="sync-card">
      <h3>学习进度</h3>
      <p class="hint">
        进度以 <code>progress.json</code> 保存在云端：已掌握词根取并集，测验/闪卡计数取最大值，
        因此多设备同时使用不会互相覆盖。
      </p>
      <div class="sync-actions">
        <button :disabled="busy" @click="downloadProgress">导出进度 JSON</button>
        <button :disabled="busy || !syncState.connected" @click="run(refreshRemoteDatasets, '已刷新云端数据集')">
          刷新云端数据集
        </button>
        <button class="danger" :disabled="busy" @click="confirmReset">清空本地进度</button>
      </div>
      <div class="field" style="margin-top: 12px">
        <label for="progress-import">粘贴进度 JSON 以导入</label>
        <textarea id="progress-import" v-model="importText" placeholder='{"mastered":{"trans":true}}' />
      </div>
      <button :disabled="busy || !importText.trim()" @click="applyImportedProgress">导入进度</button>
    </section>

    <section class="sync-card">
      <h3>
        同步日志
        <button class="ghost" style="float: right" @click="clearLogs">清空</button>
      </h3>
      <pre class="log">{{ syncLogs.items.length ? syncLogs.items.map((entry) => `[${formatTime(entry.time)}] ${entry.level.toUpperCase()} ${entry.message}`).join('\n') : '暂无日志' }}</pre>
      <p class="hint" style="margin-bottom: 0">
        进度统计：已掌握 {{ Object.keys(progress.mastered).length }} 个词根 / 测验
        {{ progress.quizTotal }} 题 / 闪卡 {{ progress.flashSeen }} 张
      </p>
    </section>
  </div>
</template>
