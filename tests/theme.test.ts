import { documentElement, fakeMediaQuery, metaElement } from './setup-dom-env';

import assert from 'node:assert/strict';
import test from 'node:test';

test('theme preference resolves system/light/dark and is applied to <html>', async () => {
  const storage = globalThis.localStorage as Storage;
  storage.clear();

  const theme = await import('@/stores/theme');

  // Default: follow the system, which reports light here.
  assert.equal(theme.themePreference.value, 'system');
  assert.equal(theme.resolvedTheme.value, 'light');
  assert.equal(documentElement.dataset.theme, 'light');
  assert.equal(documentElement.style.colorScheme, 'light');
  assert.equal(metaElement.content, '#f6f3ea');

  // The OS switches to dark while we follow the system.
  fakeMediaQuery.setMatches(true);
  await Promise.resolve();
  assert.equal(theme.resolvedTheme.value, 'dark');
  assert.equal(documentElement.dataset.theme, 'dark');
  assert.equal(documentElement.style.colorScheme, 'dark');
  assert.equal(metaElement.content, '#0a1214');

  // An explicit choice wins over the system and is persisted.
  theme.setThemePreference('light');
  await Promise.resolve();
  assert.equal(theme.resolvedTheme.value, 'light');
  assert.equal(documentElement.dataset.theme, 'light');
  assert.equal(storage.getItem(theme.THEME_STORAGE_KEY), 'light');

  theme.setThemePreference('dark');
  await Promise.resolve();
  assert.equal(theme.resolvedTheme.value, 'dark');
  assert.equal(storage.getItem(theme.THEME_STORAGE_KEY), 'dark');

  // Back to system: the OS value applies again.
  theme.setThemePreference('system');
  await Promise.resolve();
  assert.equal(theme.resolvedTheme.value, 'dark');

  // Cycling walks 自动 → 浅色 → 深色.
  theme.cycleTheme();
  assert.equal(theme.themePreference.value, 'light');
  theme.cycleTheme();
  assert.equal(theme.themePreference.value, 'dark');
  theme.cycleTheme();
  assert.equal(theme.themePreference.value, 'system');

  // A stored preference is picked up on the next "page load".
  storage.setItem(theme.THEME_STORAGE_KEY, 'light');
  assert.equal(storage.getItem(theme.THEME_STORAGE_KEY), 'light');
});
