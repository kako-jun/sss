import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Global teardown ordering matters for hooks that schedule recurring timers
// (useSlideshow runs a ~16ms progress interval). We must unmount every mounted
// component *before* restoring real timers, otherwise a queued fake-timer
// callback can leak into the real Node timer queue and fire after the jsdom
// environment is torn down ("window is not defined"). Order:
//   1. unmount React trees (effect cleanup clears the intervals)
//   2. drop any timer callback still queued under fake timers
//   3. restore real timers / mocks
afterEach(() => {
  cleanup();
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  vi.restoreAllMocks();
});
