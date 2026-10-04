import { describe, expect, it } from 'vitest';

import { threadState } from './thread.ts';

describe('threadState', () => {
  it('is working while a runner holds the thread, whatever is queued', () => {
    expect(threadState({ leaseHeld: true, queued: 0 })).toBe('working');
    expect(threadState({ leaseHeld: true, queued: 3 })).toBe('working');
  });

  it('is waking up when messages wait for a runner, idle otherwise', () => {
    expect(threadState({ leaseHeld: false, queued: 1 })).toBe('waking_up');
    expect(threadState({ leaseHeld: false, queued: 0 })).toBe('idle');
  });
});
