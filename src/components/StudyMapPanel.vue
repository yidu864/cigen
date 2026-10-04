<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

import { datasetState } from '@/stores/dataset';
import { masteryOf, setMastered } from '@/stores/progress';
import type { Entry } from '@/types';

const props = defineProps<{ loading: boolean }>();

const query = ref('');
const selectedRoot = ref<string>('');
const limit = ref(40);
const detailRef = ref<HTMLElement | null>(null);

const filteredRoots = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) {
    return datasetState.roots;
  }
  return datasetState.roots.filter((item) => {
    if (item.root.includes(q) || (item.gloss || '').includes(q)) {
      return true;
    }
    if ((item.sampleWords || []).some((word) => word.includes(q))) {
      return true;
    }
    const entries = datasetState.rootToEntries.get(item.root) ?? [];
    return entries.some((entry) => (entry.meaning || '').includes(q));
  });
});

const visibleRoots = computed(() => filteredRoots.value.slice(0, limit.value));

const currentRoot = computed(() => {
  const root = selectedRoot.value || datasetState.roots[0]?.root || '';
  return datasetState.rootMap.get(root) ?? null;
});

const relatedEntries = computed<Entry[]>(() => {
  if (!currentRoot.value) {
    return [];
  }
  return (datasetState.rootToEntries.get(currentRoot.value.root) ?? []).slice(0, 24);
});

/** On narrow screens the list sits above the detail, so follow the selection. */
function scrollDetailIntoView(): void {
  if (typeof window === 'undefined' || !window.matchMedia('(max-width: 900px)').matches) {
    return;
  }
  void nextTick(() => {
    detailRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function selectRoot(root: string): void {
  const changed = selectedRoot.value !== root;
  selectedRoot.value = root;
  if (changed) {
    scrollDetailIntoView();
  }
}

function randomRoot(): void {
  const pool = filteredRoots.value.length ? filteredRoots.value : datasetState.roots;
  if (!pool.length) {
    return;
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  selectRoot(chosen.root);
}

function onSearchInput(): void {
  limit.value = 40;
}

function loadMore(): void {
  limit.value += 60;
}

function toggleMastered(): void {
  if (!currentRoot.value) {
    return;
  }
  setMastered(currentRoot.value.root, !masteryOf(currentRoot.value.root));
}
</script>

<template>
  <div>
    <div class="toolbar">
      <input
        v-model="query"
        type="search"
        placeholder="搜索词根/词缀/中文提示，例如: trans, anti, 反"
        @input="onSearchInput"
      />
      <button :disabled="!datasetState.roots.length" @click="randomRoot">随机词根</button>
    </div>

    <p v-if="props.loading" class="hint">数据加载中…</p>

    <div class="map-layout">
      <aside class="root-list">
        <div v-if="!filteredRoots.length" class="hint">没有找到匹配项，试试更短关键词。</div>
        <div
          v-for="item in visibleRoots"
          :key="item.root"
          class="root-item"
          :class="{ active: currentRoot && item.root === currentRoot.root }"
          @click="selectRoot(item.root)"
        >
          <div class="root-head">
            <span class="root-key">{{ item.root }}</span>
            <span>{{ item.wordCount }}词</span>
          </div>
          <div class="root-gloss">{{ item.gloss || '点击查看例词联想' }}</div>
        </div>
        <button
          v-if="filteredRoots.length > visibleRoots.length"
          class="ghost"
          style="width: 100%"
          @click="loadMore"
        >
          加载更多（剩余 {{ filteredRoots.length - visibleRoots.length }}）
        </button>
      </aside>

      <article ref="detailRef" class="root-detail">
        <template v-if="currentRoot">
          <div class="detail-head">
            <div class="detail-root">{{ currentRoot.root }}</div>
            <span class="chip">{{ currentRoot.gloss || '建议通过例词记忆' }}</span>
            <span class="chip">{{ currentRoot.wordCount }} 个相关词</span>
            <button
              class="chip"
              :class="{ ok: masteryOf(currentRoot.root) }"
              @click="toggleMastered"
            >
              {{ masteryOf(currentRoot.root) ? '已掌握' : '标记为已掌握' }}
            </button>
          </div>

          <p class="hint" style="margin-top: 10px">
            例词拆解（优先展示包含此词根/词缀的词条）：
          </p>

          <div v-if="relatedEntries.length" class="examples">
            <div v-for="entry in relatedEntries" :key="entry.id + entry.word" class="example-card">
              <div class="example-word">{{ entry.word }}</div>
              <div class="example-meaning">{{ entry.meaning }}</div>
              <div class="example-decomp">{{ entry.decomposition }}</div>
            </div>
          </div>
          <p v-else class="hint">暂无相关例词。</p>
        </template>
        <template v-else>
          <h2>选择左侧词根查看详情</h2>
          <p>你可以先从高频词根开始，再结合例词做联想记忆。</p>
        </template>
      </article>
    </div>
  </div>
</template>
