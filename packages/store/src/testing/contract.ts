import { describe, expect, it } from 'vitest';

import type { ThreadStore } from '../store.ts';

/**
 * What every ThreadStore must do, whatever the backend. The runner and the
 * client rely on exactly these semantics, so each implementation runs this suite.
 */
export function storeContract(name: string, makeStore: () => Promise<ThreadStore>) {
  const thread = () => crypto.randomUUID();
  const message = (text: string, deliver: 'later' | 'asap' | 'now' = 'later', createdAt = Date.now()) => ({
    id: crypto.randomUUID(),
    text,
    deliver,
    createdAt
  });

  describe(`ThreadStore contract: ${name}`, () => {
    it('returns pending messages `now` first, then in arrival order', async () => {
      const store = await makeStore();
      const t = thread();
      await store.enqueue(t, message('a', 'later', 1));
      await store.enqueue(t, message('b', 'asap', 2));
      await store.enqueue(t, message('c', 'now', 3));
      await store.enqueue(t, message('d', 'later', 4));
      expect((await store.pending(t)).map((m) => m.text)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('delivers a message once, and forgets its caller token when it does', async () => {
      const store = await makeStore();
      const t = thread();
      const m = await store.enqueue(t, { ...message('a'), callerToken: 'encrypted-token' });
      expect((await store.pending(t))[0]?.callerToken).toBe('encrypted-token');

      expect(await store.claim(t, m.id, Date.now())).toBe(true);
      expect(await store.claim(t, m.id, Date.now())).toBe(false);
      expect(await store.pending(t)).toEqual([]);
    });

    it('cancels only what is still queued', async () => {
      const store = await makeStore();
      const t = thread();
      const queued = await store.enqueue(t, message('queued'));
      const delivered = await store.enqueue(t, message('delivered'));
      await store.claim(t, delivered.id, Date.now());

      expect(await store.cancel(t, queued.id)).toBe('cancelled');
      expect(await store.cancel(t, delivered.id)).toBe('delivered');
      expect(await store.cancel(t, crypto.randomUUID())).toBe('missing');
      expect(await store.claim(t, queued.id, Date.now())).toBe(false);
    });

    it('pages the feed by an increasing cursor', async () => {
      const store = await makeStore();
      const t = thread();
      const first = await store.append(t, [{ type: 'RUN_ERROR', message: '1' }, { type: 'RUN_ERROR', message: '2' }], 1);
      await store.append(t, [{ type: 'RUN_ERROR', message: '3' }], 2);

      const all = await store.feed(t);
      expect(all.map((e) => (e.event.type === 'RUN_ERROR' ? e.event.message : ''))).toEqual(['1', '2', '3']);
      expect([...all.map((e) => e.cursor)].sort()).toEqual(all.map((e) => e.cursor));
      const after = await store.feed(t, { after: first[1]!.cursor });
      expect(after.map((e) => e.cursor)).toEqual([all[2]!.cursor]);
      expect(await store.feed(t, { limit: 2 })).toHaveLength(2);
    });

    it('grants the lease to one holder until it expires, and only the holder renews or releases it', async () => {
      const store = await makeStore();
      const t = thread();
      expect(await store.acquireLease(t, 'a', 2_000, 1_000)).toBe(true);
      expect(await store.acquireLease(t, 'b', 2_500, 1_500)).toBe(false);
      expect(await store.acquireLease(t, 'a', 2_500, 1_500)).toBe(false);
      expect(await store.leaseHolder(t, 1_500)).toBe('a');

      expect(await store.renewLease(t, 'b', 9_000)).toBe(false);
      expect(await store.renewLease(t, 'a', 3_000)).toBe(true);
      await store.releaseLease(t, 'b');
      expect(await store.leaseHolder(t, 2_000)).toBe('a');

      expect(await store.acquireLease(t, 'b', 5_000, 3_001)).toBe(true);
      expect(await store.renewLease(t, 'a', 9_000)).toBe(false);
      await store.releaseLease(t, 'b');
      expect(await store.leaseHolder(t, 3_002)).toBeNull();
    });

    it('hands an interrupt request over once', async () => {
      const store = await makeStore();
      const t = thread();
      expect(await store.takeInterrupt(t)).toBe(false);
      await store.requestInterrupt(t, 1);
      expect(await store.takeInterrupt(t)).toBe(true);
      expect(await store.takeInterrupt(t)).toBe(false);
    });

    it('accepts wake and credential requests, throttling wakes when asked to', async () => {
      const store = await makeStore();
      const t = thread();
      await store.requestWake(t, 1_000, 30_000);
      await store.requestWake(t, 2_000, 30_000);
      await store.requestWake(t, 40_000, 30_000);
      await store.requestCredentials(t, 3);
    });

    it('keeps threads apart, and deletes one completely', async () => {
      const store = await makeStore();
      const [t1, t2] = [thread(), thread()];
      await store.enqueue(t1, message('mine'));
      await store.append(t1, [{ type: 'RUN_ERROR', message: 'mine' }], 1);
      await store.acquireLease(t1, 'a', 10_000, 1);
      await store.enqueue(t2, message('theirs'));

      expect((await store.pending(t2)).map((m) => m.text)).toEqual(['theirs']);
      expect(await store.feed(t2)).toEqual([]);

      await store.deleteThread(t1);
      expect(await store.pending(t1)).toEqual([]);
      expect(await store.feed(t1)).toEqual([]);
      expect(await store.leaseHolder(t1, 2)).toBeNull();
      expect(await store.pending(t2)).toHaveLength(1);
    });
  });
}
