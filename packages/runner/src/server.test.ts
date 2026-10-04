import { createMemoryStore } from '@zboule/wasp-store';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { type RunnerServerDeps, createRunnerServer } from './server.ts';
import { gate, scriptedAgent } from './testing/scriptedAgent.ts';

const credentials = { accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3_600_000).toISOString() };
const claude = { CLAUDE_CODE_OAUTH_TOKEN: 'oat' };

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(overrides: Partial<RunnerServerDeps> = {}) {
  const store = createMemoryStore();
  const slow = gate();
  const { agent } = scriptedAgent((text) => (text === 'slow' ? [{ tool: 'work', until: slow.promise }] : [{ say: `echo:${text}` }]));
  const seen: { threadId: string; accessKeyId: string }[] = [];
  const server = createRunnerServer({
    owner: 'test',
    pollMs: 2,
    log: () => undefined,
    forThread(threadId, creds) {
      seen.push({ threadId, accessKeyId: creds().accessKeyId });
      return { store, agent };
    },
    ...overrides
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const invoke = (threadId: string, body: object, session = threadId) =>
    fetch(`${url}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': session },
      body: JSON.stringify({ threadId, credentials, claude, ...body })
    });
  const ping = async () => ((await (await fetch(`${url}/ping`)).json()) as { status: string }).status;
  return { store, slow, seen, invoke, ping };
}

const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition never held');
};

describe('runner server', () => {
  it('acknowledges a drain at once, reports busy while it runs, and drains the thread', async () => {
    const { store, slow, invoke, ping } = await start();
    const thread = crypto.randomUUID();
    await store.enqueue(thread, { id: 'm1', text: 'slow', deliver: 'later', createdAt: 1 });

    const res = await invoke(thread, { op: 'drain' });
    expect(res.status).toBe(202);
    await until(async () => (await ping()) === 'HealthyBusy');

    slow.open();
    await until(async () => (await ping()) === 'Healthy');
    expect((await store.feed(thread)).at(-1)?.event).toMatchObject({ type: 'RUN_FINISHED' });
  });

  it('refuses an invocation whose session is not the thread', async () => {
    const { invoke } = await start();
    const res = await invoke(crypto.randomUUID(), { op: 'drain' }, crypto.randomUUID());
    expect(res.status).toBe(400);
  });

  it('serves one thread per microVM', async () => {
    const { store, invoke } = await start();
    const first = crypto.randomUUID();
    await store.enqueue(first, { id: 'm1', text: 'hi', deliver: 'later', createdAt: 1 });
    expect((await invoke(first, { op: 'drain' })).status).toBe(202);
    expect((await invoke(crypto.randomUUID(), { op: 'drain' })).status).toBe(409);
  });

  it('asks for fresh credentials shortly before they expire', async () => {
    const { store, slow, invoke } = await start();
    const thread = crypto.randomUUID();
    await store.enqueue(thread, { id: 'm1', text: 'slow', deliver: 'later', createdAt: 1 });
    const expiring = { ...credentials, expiration: new Date(Date.now() + 60_000).toISOString() };
    await invoke(thread, { op: 'drain', credentials: expiring });
    await until(async () => store.signals(thread).credentials === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.signals(thread).credentials).toBe(1);
    slow.open();
  });

  it('builds storage only from the credentials the waker sent, and takes refreshed ones', async () => {
    const { store, seen, invoke } = await start();
    const thread = crypto.randomUUID();
    await store.enqueue(thread, { id: 'm1', text: 'hi', deliver: 'later', createdAt: 1 });
    await invoke(thread, { op: 'drain' });
    expect(seen).toEqual([{ threadId: thread, accessKeyId: 'AKIA' }]);

    const res = await invoke(thread, { op: 'refresh', credentials: { ...credentials, accessKeyId: 'AKIA-2' } });
    expect(res.status).toBe(200);
  });
});
