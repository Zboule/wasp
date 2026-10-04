import type { FeedEntry, FeedEvent } from '@zboule/wasp-protocol';

import { type CancelResult, type NewMessage, type StoredMessage, type ThreadStore, orderKey } from './store.ts';

type Thread = {
  queue: Map<string, StoredMessage & { delivered: boolean }>;
  feed: FeedEntry[];
  lease: { owner: string; until: number } | null;
  interrupt: boolean;
  seq: number;
  signals: { wake: number; credentials: number };
};

/** For tests and local development. Semantics match the DynamoDB store. `signals` counts wake/credential requests. */
export function createMemoryStore(): ThreadStore & { signals(threadId: string): { wake: number; credentials: number } } {
  const threads = new Map<string, Thread>();
  const thread = (id: string): Thread => {
    let t = threads.get(id);
    if (!t) threads.set(id, (t = { queue: new Map(), feed: [], lease: null, interrupt: false, seq: 0, signals: { wake: 0, credentials: 0 } }));
    return t;
  };

  return {
    signals: (threadId: string) => ({ ...thread(threadId).signals }),
    async enqueue(threadId, message: NewMessage) {
      const stored = { ...message, order: orderKey(message.deliver, message.createdAt, message.id) };
      thread(threadId).queue.set(message.id, { ...stored, delivered: false });
      return stored;
    },
    async pending(threadId) {
      return [...thread(threadId).queue.values()]
        .filter((m) => !m.delivered)
        .sort((a, b) => a.order.localeCompare(b.order))
        .map(({ delivered: _delivered, ...m }) => m);
    },
    async claim(threadId, messageId) {
      const m = thread(threadId).queue.get(messageId);
      if (!m || m.delivered) return false;
      m.delivered = true;
      delete m.callerToken;
      return true;
    },
    async cancel(threadId, messageId): Promise<CancelResult> {
      const t = thread(threadId);
      const m = t.queue.get(messageId);
      if (!m) return 'missing';
      if (m.delivered) return 'delivered';
      t.queue.delete(messageId);
      return 'cancelled';
    },
    async append(threadId, events: FeedEvent[], at) {
      const t = thread(threadId);
      const entries = events.map((event) => ({ cursor: String(++t.seq).padStart(12, '0'), at, event }));
      t.feed.push(...entries);
      return entries;
    },
    async feed(threadId, { after = null, limit = 500 } = {}) {
      return thread(threadId)
        .feed.filter((e) => after === null || e.cursor > after)
        .slice(0, limit);
    },
    async acquireLease(threadId, owner, until, now) {
      const t = thread(threadId);
      if (t.lease && t.lease.until > now) return false;
      t.lease = { owner, until };
      return true;
    },
    async renewLease(threadId, owner, until) {
      const t = thread(threadId);
      if (t.lease?.owner !== owner) return false;
      t.lease.until = until;
      return true;
    },
    async releaseLease(threadId, owner) {
      const t = thread(threadId);
      if (t.lease?.owner === owner) t.lease = null;
    },
    async leaseHolder(threadId, now) {
      const lease = thread(threadId).lease;
      return lease && lease.until > now ? lease.owner : null;
    },
    async requestWake(threadId) {
      thread(threadId).signals.wake++;
    },
    async requestCredentials(threadId) {
      thread(threadId).signals.credentials++;
    },
    async requestInterrupt(threadId) {
      thread(threadId).interrupt = true;
    },
    async takeInterrupt(threadId) {
      const t = thread(threadId);
      const requested = t.interrupt;
      t.interrupt = false;
      return requested;
    },
    async deleteThread(threadId) {
      threads.delete(threadId);
    }
  };
}
