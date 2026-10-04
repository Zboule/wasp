import type { Deliver, FeedEvent } from './events.ts';

/**
 * A file a user attached to a message. The bytes live in S3 at `ref`
 * (`payloads/<threadId>/files/<id>/<name>`); the runner puts them in the
 * agent's working directory. Shaped to serve files the agent hands back too.
 */
export type WaspFile = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  ref: string;
  /** A short-lived download URL. Set only in what the client's `feed` returns. */
  url?: string;
};

/** A message waiting in a thread's queue, as the app sees it. */
export type QueuedMessage = {
  id: string;
  text: string;
  deliver: Deliver;
  createdAt: number;
  attachments?: WaspFile[];
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
