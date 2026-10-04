import type { Deliver, FeedEntry, FeedEvent, QueuedMessage } from '@zboule/wasp-protocol';

/** A queued message as stored: what the app sees, plus what only the runner needs. */
export type StoredMessage = QueuedMessage & {
  /** Sort key: `now` messages first, then FIFO. */
  order: string;
  /** The caller's token, encrypted by the client; only the runner can decrypt it. */
  callerToken?: string;
};

export type NewMessage = { id: string; text: string; deliver: Deliver; createdAt: number; callerToken?: string };

export type CancelResult = 'cancelled' | 'delivered' | 'missing';

/**
 * Everything wasp persists about a thread except the SDK transcript (which the
 * Agent SDK's SessionStore owns). One implementation per backend; the runner and
 * the client only ever talk to this.
 */
export interface ThreadStore {
  enqueue(threadId: string, message: NewMessage): Promise<StoredMessage>;
  /** Undelivered messages, in delivery order. */
  pending(threadId: string): Promise<StoredMessage[]>;
  /** queued → delivered. False when it was cancelled or delivered already: deliver it only on true. */
  claim(threadId: string, messageId: string, at: number): Promise<boolean>;
  cancel(threadId: string, messageId: string): Promise<CancelResult>;

  append(threadId: string, events: FeedEvent[], at: number): Promise<FeedEntry[]>;
  feed(threadId: string, options?: { after?: string | null; limit?: number }): Promise<FeedEntry[]>;

  /** Succeeds only when the lease is free or expired. Never re-entrant: one holder, one drain. */
  acquireLease(threadId: string, owner: string, until: number, now: number): Promise<boolean>;
  /** False when `owner` no longer holds it. */
  renewLease(threadId: string, owner: string, until: number): Promise<boolean>;
  releaseLease(threadId: string, owner: string): Promise<void>;
  leaseHolder(threadId: string, now: number): Promise<string | null>;

  /**
   * Asks the waker to (re)start a drain: how a stalled thread is picked up again.
   * Ignored when the last request is younger than `minIntervalMs`, so a polling
   * UI cannot turn one stalled thread into a stream of invocations.
   */
  requestWake(threadId: string, at: number, minIntervalMs?: number): Promise<void>;
  /** Asks the waker for fresh thread-scoped credentials before the current ones expire. */
  requestCredentials(threadId: string, at: number): Promise<void>;

  requestInterrupt(threadId: string, at: number): Promise<void>;
  /** Consumes a pending interrupt request, if any. */
  takeInterrupt(threadId: string): Promise<boolean>;

  deleteThread(threadId: string): Promise<void>;
}

export function orderKey(deliver: Deliver, createdAt: number, id: string): string {
  return `${deliver === 'now' ? '0' : '1'}#${String(createdAt).padStart(16, '0')}#${id}`;
}
