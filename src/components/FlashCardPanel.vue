<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { datasetState } from '@/stores/dataset';
import { masteredCount, noteFlashSeen, setMastered } from '@/stores/progress';

const pool = ref<string[]>([]);
const index = ref(0);
const revealed = ref(false);

function shuffle<T>(items: T[]): T[] {
  const array = items.slice();
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function reset(): void {
  pool.value = shuffle(
    datasetState.roots.filter((item) => item.wordCount >= 2).map((item) => item.root),
  );
  index.value = 0;
  revealed.value = false;
}

watch(() => datasetState.roots, reset, { immediate: true });

const currentRoot = computed(() => pool.value[index.value] ?? '');
const currentData = computed(() =>
  currentRoot.value ? datasetState.rootMap.get(currentRoot.value) ?? null : null,
);

const sampleEntry = computed(() => {
  if (!currentRoot.value) {
    return null;
  }
  return (datasetState.rootToEntries.get(currentRoot.value) ?? [])[0] ?? null;
});

const meta = computed(() => {
  if (!pool.value.length) {
    return '没有可用闪卡。';
  }
  return `第 ${index.value + 1}/${pool.value.length} 张 | 已掌握 ${masteredCount()}`;
});

function advance(randomJump = false): void {
  if (!pool.value.length) {
    return;
  }
  index.value = randomJump
    ? Math.floor(Math.random() * pool.value.length)
    : (index.value + 1) % pool.value.length;
  revealed.value = false;
  noteFlashSeen();
}

function reveal(): void {
  revealed.value = true;
}

function know(): void {
  if (currentRoot.value) {
    setMastered(currentRoot.value, true);
  }
  advance();
}
</script>

<template>
  <div class="flash-wrap">
    <div class="flash-meta">{{ meta }}</div>
    <div class="flash-card">
      <template v-if="currentData">
        <div>请回忆这个词根/词缀的含义和常见单词：</div>
        <div class="flash-root">{{ currentData.root }}</div>
        <template v-if="revealed">
          <div>提示: {{ currentData.gloss || '建议通过例词理解' }}</div>
          <div>例词: {{ (currentData.sampleWords || []).slice(0, 8).join(', ') }}</div>
          <div v-if="sampleEntry">拆解示例: {{ sampleEntry.word }} -&gt; {{ sampleEntry.decomposition }}</div>
        </template>
      </template>
      <template v-else>
        <div>没有可用闪卡，请检查数据文件。</div>
      </template>
    </div>

    <div class="flash-actions">
      <button :disabled="revealed || !currentData" @click="reveal">显示答案</button>
      <button id="flashAgain" :disabled="!revealed" @click="advance()">再看一次</button>
      <button id="flashKnow" :disabled="!revealed" @click="know">我记住了</button>
      <button @click="advance(true)">下一张</button>
    </div>
  </div>
</template>
