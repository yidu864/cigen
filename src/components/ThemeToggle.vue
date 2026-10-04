<script setup lang="ts">
import { setThemePreference, themePreference, type ThemePreference } from '@/stores/theme';

const options: Array<{ value: ThemePreference; label: string; title: string }> = [
  { value: 'system', label: '自动', title: '跟随系统外观' },
  { value: 'light', label: '浅色', title: '始终使用浅色主题' },
  { value: 'dark', label: '深色', title: '始终使用深色主题' },
];
</script>

<template>
  <div class="theme-toggle" role="group" aria-label="主题切换">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :class="{ active: themePreference === option.value }"
      :aria-pressed="themePreference === option.value"
      :title="option.title"
      @click="setThemePreference(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
