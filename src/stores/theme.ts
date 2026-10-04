import { computed, ref, watchEffect } from 'vue';

/**
 * Theme handling.
 *
 * The user picks `system | light | dark`; the *resolved* theme is written to
 * `<html data-theme>` so all styling is driven by CSS variables.
 *
 * `index.html` contains a tiny inline bootstrap that applies the same decision
 * before the bundle loads, so the first paint already has the right colours.
 * Keep `THEME_STORAGE_KEY` in sync with that snippet.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'cigen-theme-v1';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';
const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#f6f3ea', dark: '#0a1214' };

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isPreference(raw)) {
      return raw;
    }
  } catch {
    /* storage unavailable — fall back to the system preference */
  }
  return 'system';
}

export const themePreference = ref<ThemePreference>(readStoredPreference());

const mediaQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_MEDIA_QUERY)
    : null;

export const prefersDark = ref(mediaQuery?.matches ?? false);

if (mediaQuery) {
  const onChange = (event: MediaQueryListEvent): void => {
    prefersDark.value = event.matches;
  };
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onChange);
  } else if (typeof mediaQuery.addListener === 'function') {
    // Safari < 14
    mediaQuery.addListener(onChange);
  }
}

export const resolvedTheme = computed<ResolvedTheme>(() =>
  themePreference.value === 'system'
    ? prefersDark.value
      ? 'dark'
      : 'light'
    : themePreference.value,
);

export function setThemePreference(preference: ThemePreference): void {
  themePreference.value = preference;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* ignore */
  }
}

/** Cycle 自动 → 浅色 → 深色 (used by keyboard shortcuts / compact buttons). */
export function cycleTheme(): void {
  const order: ThemePreference[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(themePreference.value) + 1) % order.length];
  setThemePreference(next);
}

watchEffect(() => {
  const theme = resolvedTheme.value;
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', THEME_COLORS[theme]);
  }
});
