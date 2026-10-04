import type { Deliver, FeedEvent } from './events.ts';

/** A message waiting in a thread's queue, as the app sees it. */
export type QueuedMessage = {
  id: string;
  text: string;
  deliver: Deliver;
  createdAt: number;
};

/**
 * - `idle`: nothing queued, nothing running.
 * - `waking_up`: messages are queued and no runner holds the thread yet (cold start).
 * - `working`: a runner holds the thread.
 */
export type ThreadState = 'idle' | 'waking_up' | 'working';

/** One feed entry. `cursor` is opaque and increases; pass the last one seen as `after`. */
export type FeedEntry = { cursor: string; at: number; event: FeedEvent };

export type FeedPage = {
  state: ThreadState;
  queue: QueuedMessage[];
  entries: FeedEntry[];
  /** The cursor to pass as `after` next time; unchanged when there was nothing new. */
  cursor: string | null;
};

export function threadState({ leaseHeld, queued }: { leaseHeld: boolean; queued: number }): ThreadState {
  if (leaseHeld) return 'working';
  return queued > 0 ? 'waking_up' : 'idle';
}
