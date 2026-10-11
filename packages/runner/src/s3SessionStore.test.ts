import { CreateBucketCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import { createS3SessionStore } from './s3SessionStore.ts';

/** Integration: runs against an S3-compatible server when WASP_S3_ENDPOINT is set (`docker compose -f docker-compose.test.yml up`; CI's integration job). */
const endpoint = process.env.WASP_S3_ENDPOINT;
const entry = (uuid: string, text = uuid): SessionStoreEntry => ({ type: 'user', uuid, message: { role: 'user', content: text } }) as SessionStoreEntry;

(endpoint ? describe : describe.skip)('S3 session store (S3Mock)', () => {
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.WASP_S3_KEY ?? 'test', secretAccessKey: process.env.WASP_S3_SECRET ?? 'test' }
  });
  const bucket = `wasp-test-${crypto.randomUUID().slice(0, 8)}`;
  const key = { projectKey: '/work/thread', sessionId: 'session-1' };

  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  it('returns null for a session never written', async () => {
    expect(await createS3SessionStore({ client, bucket, threadId: crypto.randomUUID() }).load(key)).toBeNull();
  });

  it('resumes the transcript in order on another store instance (another microVM), ignoring replays', async () => {
    const threadId = crypto.randomUUID();
    const first = createS3SessionStore({ client, bucket, threadId });
    await first.append(key, [entry('a'), entry('b')]);
    await first.append(key, [entry('b'), entry('c')]);
    await first.append({ ...key, subpath: 'subagents/agent-1' }, [entry('sub')]);

    const later = createS3SessionStore({ client, bucket, threadId });
    expect((await later.load(key))?.map((e) => e.uuid)).toEqual(['a', 'b', 'c']);
    expect((await later.load({ ...key, subpath: 'subagents/agent-1' }))?.map((e) => e.uuid)).toEqual(['sub']);
  });

  it('keeps every object under sessions/<threadId>/', async () => {
    const threadId = crypto.randomUUID();
    await createS3SessionStore({ client, bucket, threadId }).append(key, [entry('x')]);
    const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `sessions/${threadId}/` }));
    expect(out.KeyCount).toBe(1);
  });

  it('merges a long session into one chunk without losing or duplicating anything', async () => {
    const threadId = crypto.randomUUID();
    const store = createS3SessionStore({ client, bucket, threadId });
    for (let i = 0; i < 60; i++) await store.append(key, [entry(`e${String(i).padStart(2, '0')}`)]);

    const expected = Array.from({ length: 60 }, (_, i) => `e${String(i).padStart(2, '0')}`);
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual(expected);
    await store.append(key, [entry('after')]);

    const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `sessions/${threadId}/` }));
    expect(list.KeyCount).toBe(2);
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual([...expected, 'after']);
  });
});

/** An in-memory S3 that counts calls: enough of the API for the store. */
function fakeS3() {
  const objects = new Map<string, string>();
  const calls = { list: 0, get: 0, put: 0 };
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      const input = command.input;
      if (command instanceof ListObjectsV2Command) {
        calls.list++;
        const keys = [...objects.keys()].filter((k) => k.startsWith(String(input.Prefix))).sort();
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      if (command instanceof GetObjectCommand) {
        calls.get++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        const body = objects.get(String(input.Key)) ?? '';
        return { Body: { transformToString: async () => body } };
      }
      if (command instanceof PutObjectCommand) {
        calls.put++;
        objects.set(String(input.Key), String(input.Body));
        return {};
      }
      if (command instanceof DeleteObjectsCommand) {
        for (const { Key } of (input.Delete as { Objects: { Key: string }[] }).Objects) objects.delete(Key);
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    }
  };
  return { client: client as unknown as S3Client, objects, calls, maxInFlight: () => maxInFlight };
}

describe('S3 session store (in memory)', () => {
  const key = { projectKey: '/work/thread', sessionId: 'session-1' };

  it('reads chunks in parallel and still returns them in order', async () => {
    const s3 = fakeS3();
    const store = createS3SessionStore({ client: s3.client, bucket: 'b', threadId: 't' });
    for (let i = 0; i < 40; i++) await store.append(key, [entry(`e${String(i).padStart(2, '0')}`)]);

    const fresh = createS3SessionStore({ client: s3.client, bucket: 'b', threadId: 't' });
    expect((await fresh.load(key))?.map((e) => e.uuid)).toEqual(Array.from({ length: 40 }, (_, i) => `e${String(i).padStart(2, '0')}`));
    expect(s3.maxInFlight()).toBeGreaterThan(1);
    expect(s3.maxInFlight()).toBeLessThanOrEqual(16);
  });

  it('answers a second load of the same session from memory, until the next append', async () => {
    const s3 = fakeS3();
    const store = createS3SessionStore({ client: s3.client, bucket: 'b', threadId: 't' });
    await store.append(key, [entry('a')]);
    await store.load(key);
    const reads = s3.calls.get;
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual(['a']);
    expect(s3.calls.get).toBe(reads);

    await store.append(key, [entry('b')]);
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual(['a', 'b']);
  });

  it('does not keep a load that raced an append', async () => {
    const s3 = fakeS3();
    const store = createS3SessionStore({ client: s3.client, bucket: 'b', threadId: 't' });
    await store.append(key, [entry('a')]);
    const loading = store.load(key);
    await store.append(key, [entry('b')]);
    await loading;
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual(['a', 'b']);
  });

  it('hands out copies, so a caller cannot change what the next load returns', async () => {
    const s3 = fakeS3();
    const store = createS3SessionStore({ client: s3.client, bucket: 'b', threadId: 't' });
    await store.append(key, [entry('a')]);
    (await store.load(key))!.push(entry('injected'));
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual(['a']);
  });
});
