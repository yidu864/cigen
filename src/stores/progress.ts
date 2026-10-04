import { reactive, watch } from 'vue';

import {
  emptyProgress,
  mergeProgress,
  normalizeProgress,
  progressEquals,
  PROGRESS_VERSION,
} from '@/data/progress';
import type { Progress } from '@/types';

export {
  emptyProgress,
  mergeProgress,
  normalizeProgress,
  progressEquals,
  PROGRESS_VERSION,
};

const STORAGE_KEY = 'cigen-root-progress-v2';

export function readLocalProgress(): Progress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return emptyProgress();
    }
    return normalizeProgress(JSON.parse(raw));
  } catch {
    return emptyProgress();
  }
}

export function writeLocalProgress(snapshot: Progress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage unavailable (private mode) — progress stays in memory */
  }
}

export const progress = reactive<Progress>(readLocalProgress());

function signature(value: Progress): string {
  return JSON.stringify({
    m: Object.keys(value.mastered).sort(),
    qc: value.quizCorrect,
    qt: value.quizTotal,
    fs: value.flashSeen,
  });
}

let lastSignature = signature(progress);
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const persistListeners = new Set<(progress: Progress) => void>();

/** Register a listener that runs after the local snapshot was persisted. */
export function onProgressPersisted(listener: (progress: Progress) => void): () => void {
  persistListeners.add(listener);
  return () => {
    persistListeners.delete(listener);
  };
}

watch(
  progress,
  () => {
    if (signature(progress) === lastSignature) {
      return;
    }
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      persistNow();
    }, 400);
  },
  { deep: true },
);

/** Persist the current in-memory progress to localStorage immediately. */
export function persistNow(): Progress {
  const snapshot = normalizeProgress(progress);
  snapshot.updatedAt = new Date().toISOString();
  lastSignature = signature(snapshot);
  writeLocalProgress(snapshot);
  persistListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('[progress] persist listener failed', error);
    }
  });
  return snapshot;
}

/** Replace the in-memory progress (used by sync / import). */
export function replaceProgress(next: Progress, options: { persist?: boolean } = {}): Progress {
  const normalized = normalizeProgress(next);
  progress.mastered = normalized.mastered;
  progress.quizCorrect = normalized.quizCorrect;
  progress.quizTotal = normalized.quizTotal;
  progress.flashSeen = normalized.flashSeen;
  progress.updatedAt = normalized.updatedAt;
  lastSignature = signature(progress);
  if (options.persist !== false) {
    writeLocalProgress(normalized);
  }
  return normalized;
}

export function snapshotProgress(): Progress {
  return normalizeProgress(progress);
}

export function setMastered(root: string, mastered: boolean): void {
  if (mastered) {
    progress.mastered[root] = true;
  } else {
    delete progress.mastered[root];
  }
}

export function recordQuiz(correct: boolean): void {
  progress.quizTotal += 1;
  if (correct) {
    progress.quizCorrect += 1;
  }
}

export function noteFlashSeen(): void {
  progress.flashSeen += 1;
}

export function masteredCount(): number {
  return Object.values(progress.mastered).filter(Boolean).length;
}

export function masteryOf(root: string): boolean {
  return Boolean(progress.mastered[root]);
}

export function resetProgress(): void {
  replaceProgress(emptyProgress());
}

export function exportProgressJson(): string {
  return JSON.stringify(snapshotProgress(), null, 2);
}

export function importProgressJson(text: string): Progress {
  const normalized = normalizeProgress(JSON.parse(text) as unknown);
  replaceProgress(normalized);
  return normalized;
}
