<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import FlashCardPanel from '@/components/FlashCardPanel.vue';
import QuizPanel from '@/components/QuizPanel.vue';
import StudyMapPanel from '@/components/StudyMapPanel.vue';
import SyncPanel from '@/components/SyncPanel.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';
import { datasetState, loadDataset, setSourceEnabled, sourceStats } from '@/stores/dataset';
import { masteredCount, progress } from '@/stores/progress';
import { restoreSession, startProgressAutoPush, syncState } from '@/stores/sync';
import '@/stores/theme';

type TabName = 'map' | 'flash' | 'quiz' | 'sync';

const tabs: Array<{ id: TabName; label: string }> = [
  { id: 'map', label: '学习地图' },
  { id: 'flash', label: '闪卡训练' },
  { id: 'quiz', label: '选择题' },
  { id: 'sync', label: '云同步' },
];

const activeTab = ref<TabName>('map');

const stats = computed(() => [
  `词条 ${datasetState.entries.length}`,
  `词根/词缀 ${datasetState.roots.length}`,
  `已掌握 ${masteredCount()}`,
  `测验 ${progress.quizCorrect}/${progress.quizTotal}`,
  `闪卡 ${progress.flashSeen}`,
]);

const sourceChips = computed(() => sourceStats.value);

async function selectTab(tab: TabName): Promise<void> {
  activeTab.value = tab;
}

onMounted(async () => {
  startProgressAutoPush();
  await loadDataset();
  await restoreSession();
});
</script>

<template>
  <header class="hero">
    <div class="hero-top">
      <p class="eyebrow">Root &amp; Affix Memory Lab</p>
      <ThemeToggle />
    </div>
    <h1>词根词缀记忆工坊</h1>
    <p class="sub">
      基于 PDF / DeepSeek 对话自动提取词根词缀数据，支持检索、拆解联想、闪卡训练和选择题巩固，
      并可通过 WebDAV / Google Drive 同步学习进度。
    </p>

    <div class="stats">
      <span v-for="text in stats" :key="text" class="chip">{{ text }}</span>
    </div>

    <div v-if="sourceChips.length > 1" class="chip-row" style="margin-bottom: 14px">
      <button
        v-for="source in sourceChips"
        :key="source.id"
        class="chip"
        :class="{ 'ok': datasetState.activeSourceIds.includes(source.id) }"
        :title="`${source.entries} 个词条 / ${source.roots} 个词根`"
        @click="setSourceEnabled(source.id, !datasetState.activeSourceIds.includes(source.id))"
      >
        {{ datasetState.activeSourceIds.includes(source.id) ? '✓' : '+' }} {{ source.label }}
        ({{ source.entries }})
      </button>
    </div>

    <div v-if="datasetState.warnings.length" class="hint" style="margin-bottom: 12px">
      <div v-for="warning in datasetState.warnings" :key="warning">⚠️ {{ warning }}</div>
    </div>

    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: activeTab === tab.id }"
        @click="selectTab(tab.id)"
      >
        {{ tab.label }}
        <template v-if="tab.id === 'sync' && syncState.connected">·</template>
      </button>
    </div>
  </header>

  <main class="app">
    <section class="panel" :class="{ active: activeTab === 'map' }">
      <StudyMapPanel v-if="!datasetState.error" :loading="datasetState.loading" />
      <div v-else class="root-detail">
        <h2>数据加载失败</h2>
        <p>{{ datasetState.error }}</p>
      </div>
    </section>

    <section class="panel" :class="{ active: activeTab === 'flash' }">
      <FlashCardPanel />
    </section>

    <section class="panel" :class="{ active: activeTab === 'quiz' }">
      <QuizPanel />
    </section>

    <section class="panel" :class="{ active: activeTab === 'sync' }">
      <SyncPanel />
    </section>
  </main>
</template>
