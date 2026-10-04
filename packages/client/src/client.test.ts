import { createMemoryStore } from '@zboule/wasp-store';
import { describe, expect, it } from 'vitest';

import { createWaspClientWith } from './client.ts';

function setup() {
  const store = createMemoryStore();
  let clock = 1_000_000;
  const deleted: string[] = [];
  const client = createWaspClientWith({
    store,
    now: () => clock,
    encryptToken: async (threadId, token) => `enc(${threadId}:${token})`,
    presign: async (ref) => `https://signed.example/${ref}`,
    deleteObjects: async (threadId) => void deleted.push(threadId)
  });
  return { store, client, deleted, advance: (ms: number) => (clock += ms) };
}

describe('wasp client', () => {
  it('queues a message with its position, storing the caller token only encrypted', async () => {
    const { store, client } = setup();
    const thread = crypto.randomUUID();
    expect((await client.post(thread, { text: 'first' })).position).toBe(0);
    expect((await client.post(thread, { text: 'urgent', deliver: 'now', callerToken: 'secret' })).position).toBe(0);

    const pending = await store.pending(thread);
    expect(pending.map((m) => m.text)).toEqual(['urgent', 'first']);
    expect(pending[0]?.callerToken).toBe(`enc(${thread}:secret)`);
  });

  it('refuses a thread id that is not a UUID, and empty or oversized text', async () => {
    const { client } = setup();
    await expect(client.post('thread-1', { text: 'hi' })).rejects.toThrow(/UUID/);
    await expect(client.post(crypto.randomUUID(), { text: '  ' })).rejects.toThrow(/text/);
    await expect(client.post(crypto.randomUUID(), { text: 'x'.repeat(100_001) })).rejects.toThrow(/limited/);
  });

  it('reports the thread state and never shows caller tokens in the queue', async () => {
    const { store, client } = setup();
    const thread = crypto.randomUUID();
    expect((await client.feed(thread)).state).toBe('idle');

    await client.post(thread, { text: 'hi', callerToken: 'secret' });
    const waiting = await client.feed(thread);
    expect(waiting.state).toBe('waking_up');
    expect(JSON.stringify(waiting.queue)).not.toContain('secret');

    await store.acquireLease(thread, 'runner', 2_000_000, 1_000_000);
    expect((await client.feed(thread)).state).toBe('working');
  });

  it('pages the feed from a cursor and resolves payload references to URLs', async () => {
    const { store, client } = setup();
    const thread = crypto.randomUUID();
    await store.append(thread, [{ type: 'RUN_STARTED', threadId: thread, runId: 'r1' }], 1);
    const first = await client.feed(thread);
    await store.append(
      thread,
      [{ type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 't', content: 'preview…', outputRef: `payloads/${thread}/x.txt` }],
      2
    );

    const next = await client.feed(thread, { after: first.cursor });
    expect(next.entries.map((e) => e.event)).toEqual([
      expect.objectContaining({ outputRef: `https://signed.example/payloads/${thread}/x.txt` })
    ]);
    expect((await client.feed(thread, { after: next.cursor })).cursor).toBe(next.cursor);
  });

  it('wakes a thread whose queue has waited with no runner, at most every 30 seconds', async () => {
    const { store, client, advance } = setup();
    const thread = crypto.randomUUID();
    await client.post(thread, { text: 'hi' });
    await client.feed(thread);
    expect(store.signals(thread).wake).toBe(0);

    advance(31_000);
    await client.feed(thread);
    await client.feed(thread);
    expect(store.signals(thread).wake).toBe(1);
    advance(31_000);
    await client.feed(thread);
    expect(store.signals(thread).wake).toBe(2);
  });

  it('cancels, interrupts and deletes', async () => {
    const { store, client, deleted } = setup();
    const thread = crypto.randomUUID();
    const { messageId } = await client.post(thread, { text: 'hi' });
    expect(await client.cancel(thread, messageId)).toBe('cancelled');

    await client.interrupt(thread);
    expect(await store.takeInterrupt(thread)).toBe(true);

    await client.post(thread, { text: 'again' });
    await client.deleteThread(thread);
    expect(await store.pending(thread)).toEqual([]);
    expect(deleted).toEqual([thread]);
  });
});
