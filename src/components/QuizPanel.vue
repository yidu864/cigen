<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { datasetState } from '@/stores/dataset';
import { progress, recordQuiz } from '@/stores/progress';
import type { RootInfo } from '@/types';

interface QuizQuestion {
  prompt: string;
  correctRoot: string;
  options: string[];
}

const question = ref<QuizQuestion | null>(null);
const chosenRoot = ref<string>('');
const feedback = ref('');

function sample<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle<T>(items: T[]): T[] {
  const array = items.slice();
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function nextQuestion(): void {
  const candidates: RootInfo[] = datasetState.roots.filter((item) => item.gloss);
  if (candidates.length < 4) {
    question.value = null;
    feedback.value = '可用于选择题的数据不足（至少需要 4 个带中文提示的词根）。';
    return;
  }

  const correct = sample(candidates);
  const incorrect = shuffle(candidates.filter((item) => item.root !== correct.root))
    .slice(0, 3)
    .map((item) => item.root);

  question.value = {
    prompt: correct.gloss,
    correctRoot: correct.root,
    options: shuffle([correct.root, ...incorrect]),
  };
  chosenRoot.value = '';
  feedback.value = '';
}

watch(() => datasetState.roots, nextQuestion, { immediate: true });

const answered = computed(() => chosenRoot.value !== '');

const score = computed(() => `正确率: ${progress.quizCorrect} / ${progress.quizTotal}`);

function answer(root: string): void {
  const current = question.value;
  if (!current || answered.value) {
    return;
  }
  chosenRoot.value = root;
  const correct = root === current.correctRoot;
  recordQuiz(correct);

  const examples = (datasetState.rootMap.get(current.correctRoot)?.sampleWords ?? [])
    .slice(0, 4)
    .join(', ');
  feedback.value = correct
    ? `回答正确。例词: ${examples}`
    : `回答错误。正确答案是 ${current.correctRoot}。例词: ${examples}`;
}

function optionClass(root: string): Record<string, boolean> {
  const current = question.value;
  if (!current || !answered.value) {
    return {};
  }
  return {
    correct: root === current.correctRoot,
    wrong: root === chosenRoot.value && root !== current.correctRoot,
  };
}
</script>

<template>
  <div class="quiz-wrap">
    <div class="quiz-score">{{ score }}</div>
    <div v-if="question" class="quiz-question">
      哪个词根/词缀最接近这个提示：“{{ question.prompt }}”
    </div>
    <div v-else class="quiz-question">{{ feedback || '题目加载中…' }}</div>

    <div v-if="question" class="quiz-options">
      <button
        v-for="option in question.options"
        :key="option"
        class="quiz-option"
        :class="optionClass(option)"
        :disabled="answered"
        @click="answer(option)"
      >
        {{ option }}
      </button>
    </div>

    <div class="quiz-feedback">{{ feedback }}</div>
    <button class="primary" @click="nextQuestion">下一题</button>
  </div>
</template>
