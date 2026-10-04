import { createMemoryStore } from '@zboule/wasp-store';
import { describe, expect, it } from 'vitest';

import { createWaspClientWith } from './client.ts';

function setup() {
  const store = createMemoryStore();
  let clock = 1_000_000;
  const deleted: string[] = [];
  /** What "S3" holds: a ref is there once the test says it was uploaded. */
  const objects = new Map<string, { size: number; mediaType: string }>();
  const client = createWaspClientWith({
    store,
    now: () => clock,
    encryptToken: async (threadId, token) => `enc(${threadId}:${token})`,
    presign: async (ref, { download } = {}) => `https://signed.example/${ref}${download ? `?as=${download}` : ''}`,
    presignUpload: async (ref, { mediaType, size }) => ({ url: 'https://bucket.example/', fields: { key: ref, 'Content-Type': mediaType, size: String(size) } }),
    headObject: async (ref) => objects.get(ref) ?? null,
    deleteObjects: async (threadId) => void deleted.push(threadId),
    limits: { maxFileBytes: 1_000, maxFiles: 2 }
  });
  return { store, client, deleted, objects, advance: (ms: number) => (clock += ms) };
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
    await expect(client.post(crypto.randomUUID(), { text: '  ' })).rejects.toThrow(/text or files/);
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

  it('hands out an upload for one file of the thread, within the size limit', async () => {
    const { client } = setup();
    const thread = crypto.randomUUID();
    const upload = await client.upload(thread, { name: '../Q3 report.pdf', mediaType: 'application/pdf', size: 900 });
    expect(upload.ref).toMatch(new RegExp(`^payloads/${thread}/files/[0-9a-f-]{36}/_Q3 report\\.pdf$`));
    expect(upload.fields).toMatchObject({ key: upload.ref, 'Content-Type': 'application/pdf', size: '900' });

    expect((await client.upload(thread, { name: 'x', mediaType: 'not a type', size: 1 })).fields['Content-Type']).toBe('application/octet-stream');
    await expect(client.upload(thread, { name: 'big.bin', size: 1_001 })).rejects.toThrow(/limited/);
  });

  it('attaches uploaded files, taking their size and type from storage', async () => {
    const { store, client, objects } = setup();
    const thread = crypto.randomUUID();
    const { ref } = await client.upload(thread, { name: 'chart.png', mediaType: 'image/png', size: 10 });
    objects.set(ref, { size: 512, mediaType: 'image/png' });

    await client.post(thread, { text: '', files: [ref, ref] });
    const [message] = await store.pending(thread);
    expect(message?.attachments).toEqual([{ id: ref.split('/')[3], name: 'chart.png', mediaType: 'image/png', size: 512, ref }]);
  });

  it('refuses files of another thread, files never uploaded, and too many files', async () => {
    const { client, objects } = setup();
    const thread = crypto.randomUUID();
    const other = await client.upload(crypto.randomUUID(), { name: 'secret.txt', size: 1 });
    objects.set(other.ref, { size: 1, mediaType: 'text/plain' });
    await expect(client.post(thread, { text: 'x', files: [other.ref] })).rejects.toThrow(/not a file of this thread/);
    await expect(client.post(thread, { text: 'x', files: [`payloads/${thread}/sessions/x`] })).rejects.toThrow(/not a file of this thread/);

    const missing = await client.upload(thread, { name: 'later.txt', size: 1 });
    await expect(client.post(thread, { text: 'x', files: [missing.ref] })).rejects.toThrow(/was not uploaded/);

    const refs = await Promise.all(['a', 'b', 'c'].map(async (name) => (await client.upload(thread, { name, size: 1 })).ref));
    await expect(client.post(thread, { text: 'x', files: refs })).rejects.toThrow(/limited to 2 files/);
  });

  it('gives attachments a download URL in the queue and in the feed', async () => {
    const { store, client, objects } = setup();
    const thread = crypto.randomUUID();
    const { ref } = await client.upload(thread, { name: 'a.html', mediaType: 'text/html', size: 5 });
    objects.set(ref, { size: 5, mediaType: 'text/html' });
    const { messageId } = await client.post(thread, { text: 'look', files: [ref] });

    const page = await client.feed(thread);
    expect(page.queue[0]?.attachments?.[0]?.url).toBe(`https://signed.example/${ref}?as=a.html`);

    const [stored] = await store.pending(thread);
    await store.append(thread, [{ type: 'CUSTOM', name: 'wasp.message', value: { messageId, text: 'look', deliver: 'later', attachments: stored!.attachments! } }], 2);
    const [entry] = (await client.feed(thread)).entries;
    expect(entry?.event).toMatchObject({ value: { attachments: [expect.objectContaining({ ref, url: `https://signed.example/${ref}?as=a.html` })] } });
  });

  it('gives no URL to a ref the agent planted for another thread’s objects', async () => {
    const { store, client } = setup();
    const thread = crypto.randomUUID();
    const other = crypto.randomUUID();
    const foreign = { id: crypto.randomUUID(), name: 'x.jsonl', mediaType: 'text/plain', size: 1 };
    await store.append(
      thread,
      [
        { type: 'CUSTOM', name: 'wasp.message', value: { messageId: 'm', text: 'hi', deliver: 'later', attachments: [{ ...foreign, ref: `sessions/${other}/x.jsonl` }] } },
        { type: 'TOOL_CALL_RESULT', messageId: 'r', toolCallId: 't1', content: '…', outputRef: `sessions/${other}/x.jsonl` },
        { type: 'TOOL_CALL_ARGS', toolCallId: 't2', delta: '…', argsRef: `payloads/${thread}/../${other}/files/x` }
      ],
      1
    );
    await store.enqueue(thread, { id: 'q', text: 'x', deliver: 'later', createdAt: 1, attachments: [{ ...foreign, ref: `payloads/${other}/files/${foreign.id}/x.jsonl` }] });

    const page = await client.feed(thread);
    expect(JSON.stringify(page)).not.toContain('signed.example');
    expect(page.queue[0]?.attachments).toEqual([]);
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
