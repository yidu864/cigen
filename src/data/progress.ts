import type { Progress } from '@/types';

export const PROGRESS_VERSION = 2;

export function emptyProgress(): Progress {
  return {
    version: PROGRESS_VERSION,
    mastered: {},
    quizCorrect: 0,
    quizTotal: 0,
    flashSeen: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeProgress(raw: unknown): Progress {
  const base = emptyProgress();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const candidate = raw as Partial<Progress>;
  const mastered: Record<string, boolean> = {};
  if (candidate.mastered && typeof candidate.mastered === 'object') {
    for (const [key, value] of Object.entries(candidate.mastered)) {
      if (value) {
        mastered[key] = true;
      }
    }
  }
  return {
    version: PROGRESS_VERSION,
    mastered,
    quizCorrect: toCount(candidate.quizCorrect),
    quizTotal: toCount(candidate.quizTotal),
    flashSeen: toCount(candidate.flashSeen),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : base.updatedAt,
  };
}

function toCount(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
}

/** Union of mastered roots, max of the counters; newest `updatedAt` wins. */
export function mergeProgress(a: Progress | null, b: Progress | null): Progress {
  if (!a) {
    return normalizeProgress(b);
  }
  if (!b) {
    return normalizeProgress(a);
  }
  const mastered: Record<string, boolean> = { ...a.mastered };
  for (const [key, value] of Object.entries(b.mastered)) {
    if (value) {
      mastered[key] = true;
    }
  }
  return {
    version: PROGRESS_VERSION,
    mastered,
    quizCorrect: Math.max(a.quizCorrect, b.quizCorrect),
    quizTotal: Math.max(a.quizTotal, b.quizTotal),
    flashSeen: Math.max(a.flashSeen, b.flashSeen),
    updatedAt: a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt,
  };
}

export function progressEquals(a: Progress, b: Progress): boolean {
  if (
    a.quizCorrect !== b.quizCorrect ||
    a.quizTotal !== b.quizTotal ||
    a.flashSeen !== b.flashSeen
  ) {
    return false;
  }
  const aKeys = Object.keys(a.mastered);
  const bKeys = Object.keys(b.mastered);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => b.mastered[key]);
}
