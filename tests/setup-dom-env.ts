/**
 * DOM shims for tests that need `window.matchMedia` / `document`.
 *
 * Extends the plain browser env shim (localStorage/sessionStorage). Import this
 * *before* the module under test — the theme store reads `window.matchMedia` at
 * import time.
 */
import './setup-browser-env';

export interface FakeMediaQueryList {
  media: string;
  matches: boolean;
  /** Simulate the OS switching appearance. */
  setMatches(value: boolean): void;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
  addListener(listener: (event: { matches: boolean }) => void): void;
}

const listeners: Array<(event: { matches: boolean }) => void> = [];

export const fakeMediaQuery: FakeMediaQueryList = {
  media: '(prefers-color-scheme: dark)',
  matches: false,
  setMatches(value: boolean) {
    this.matches = value;
    listeners.forEach((listener) => listener({ matches: value }));
  },
  addEventListener(_type, listener) {
    listeners.push(listener);
  },
  addListener(listener) {
    listeners.push(listener);
  },
};

const globals = globalThis as unknown as Record<string, unknown>;

const documentElement = {
  dataset: {} as Record<string, string>,
  style: {} as Record<string, string>,
};

const metaElement = {
  content: '',
  setAttribute(name: string, value: string) {
    if (name === 'content') {
      this.content = value;
    }
  },
};

globals.window = {
  matchMedia: () => fakeMediaQuery,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

globals.document = {
  documentElement,
  hidden: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  querySelector: (selector: string) => (selector.includes('theme-color') ? metaElement : null),
  // Just enough for @vue/runtime-dom's module-scope `createElement('template')`.
  createElement: () => ({ innerHTML: '', content: { firstChild: null } }),
  createElementNS: () => ({ innerHTML: '', content: { firstChild: null } }),
};

export { documentElement, metaElement };
