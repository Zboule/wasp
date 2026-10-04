import type { Deliver, FeedEntry } from '@jorna/wasp-protocol';
import { describe, expect, it } from 'vitest';

import { drain } from './drain.ts';
import { type ThreadStore, createMemoryStore } from '@jorna/wasp-store';
import { type Script, gate, scriptedAgent } from './testing/scriptedAgent.ts';

const T = 'thread-1';
let clock = 1_000;
const now = () => ++clock;

async function post(store: ThreadStore, text: string, deliver: Deliver = 'later') {
  return store.enqueue(T, { id: `m-${text}`, text, deliver, createdAt: now() });
}

/** The feed as short strings, so a test reads like the conversation it checks. */
function story(entries: FeedEntry[]): string[] {
  return entries.flatMap(({ event: e }) => {
    switch (e.type) {
      case 'CUSTOM':
        return e.name === 'wasp.message' ? [`> ${e.value.text}`] : [`! ${e.name}`];
      case 'RUN_STARTED':
        return ['run'];
      case 'TEXT_MESSAGE_CONTENT':
        return [e.delta];
      case 'TOOL_CALL_START':
        return [`tool:${e.toolCallName}`];
      case 'TOOL_CALL_RESULT':
        return [e.isError ? 'tool-failed' : 'tool-ok'];
      case 'RUN_FINISHED':
        return [e.result.outcome];
      case 'RUN_ERROR':
        return ['error'];
      default:
        return [];
    }
  });
}

const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition never held');
};

function setup(script?: Script) {
  const store = createMemoryStore();
  const { agent, sent } = scriptedAgent(script);
  const run = (owner = 'runner-a') => drain(T, { store, agent, owner, now, pollMs: 2, leaseMs: 1_000 });
  const feed = async () => story(await store.feed(T));
  return { store, sent, run, feed };
}

describe('drain', () => {
  it('delivers a message, records the turn, and releases the thread', async () => {
    const { store, run, feed } = setup();
    await post(store, 'hello');

    expect(await run()).toBe('drained');

    expect(await feed()).toEqual(['> hello', 'run', 'echo:hello', 'done']);
    expect(await store.pending(T)).toEqual([]);
    expect(await store.leaseHolder(T, now())).toBeNull();
  });

  it('keeps `later` messages for the next turn, in order', async () => {
    const slow = gate();
    const { store, sent, run, feed } = setup((text) =>
      text === 'first' ? [{ tool: 'work', until: slow.promise }, { say: 'first done' }] : [{ say: `echo:${text}` }]
    );
    await post(store, 'first');
    const draining = run();
    await until(async () => (await feed()).includes('tool:work'));

    await post(store, 'second');
    await post(store, 'third');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.map((s) => s.text)).toEqual(['first']);

    slow.open();
    await draining;
    expect(await feed()).toEqual([
      '> first', 'run', 'tool:work', 'tool-ok', 'first done', 'done',
      '> second', 'run', 'echo:second', 'done',
      '> third', 'run', 'echo:third', 'done'
    ]);
  });

  it('slips an `asap` message into the running turn at its next tool boundary', async () => {
    const slow = gate();
    const { store, sent, run, feed } = setup((text) =>
      text === 'first' ? [{ tool: 'work', until: slow.promise }, { say: 'first done' }] : [{ say: `echo:${text}` }]
    );
    await post(store, 'first');
    const draining = run();
    await until(async () => (await feed()).includes('tool:work'));

    await post(store, 'also this', 'asap');
    await until(async () => sent.length === 2);
    expect(sent[1]).toEqual({ text: 'also this', priority: 'next' });

    slow.open();
    await draining;
    expect(await feed()).toEqual(['> first', 'run', 'tool:work', '> also this', 'tool-ok', 'ack:also this', 'first done', 'done']);
  });

  it('interrupts the running turn for a `now` message, which goes first', async () => {
    const never = gate();
    const { store, run, feed } = setup((text) =>
      text === 'first' ? [{ tool: 'work', until: never.promise }] : [{ say: `echo:${text}` }]
    );
    await post(store, 'first');
    const draining = run();
    await until(async () => (await feed()).includes('tool:work'));

    await post(store, 'queued later');
    await post(store, 'stop, do this', 'now');
    await draining;

    expect(await feed()).toEqual([
      '> first', 'run', 'tool:work', 'tool-failed', 'interrupted',
      '> stop, do this', 'run', 'echo:stop, do this', 'done',
      '> queued later', 'run', 'echo:queued later', 'done'
    ]);
  });

  it('honours an interrupt request and carries on with the queue', async () => {
    const never = gate();
    const { store, run, feed } = setup((text) =>
      text === 'first' ? [{ tool: 'work', until: never.promise }] : [{ say: `echo:${text}` }]
    );
    await post(store, 'first');
    const draining = run();
    await until(async () => (await feed()).includes('tool:work'));

    await post(store, 'next one');
    await store.requestInterrupt(T, now());
    await draining;

    expect(await feed()).toEqual(['> first', 'run', 'tool:work', 'tool-failed', 'interrupted', '> next one', 'run', 'echo:next one', 'done']);
  });

  it('never delivers a cancelled message, and cannot cancel a delivered one', async () => {
    const slow = gate();
    const { store, run, feed } = setup((text) => (text === 'first' ? [{ tool: 'work', until: slow.promise }] : [{ say: `echo:${text}` }]));
    const first = await post(store, 'first');
    const draining = run();
    await until(async () => (await feed()).includes('tool:work'));

    const changedMyMind = await post(store, 'changed my mind');
    expect(await store.cancel(T, changedMyMind.id)).toBe('cancelled');
    expect(await store.cancel(T, first.id)).toBe('delivered');

    slow.open();
    await draining;
    expect(await feed()).toEqual(['> first', 'run', 'tool:work', 'tool-ok', 'done']);
  });

  it('puts `now` messages ahead of the queue on an idle thread', async () => {
    const { store, run, feed } = setup();
    await post(store, 'a');
    await post(store, 'b', 'now');
    await run();
    expect(await feed()).toEqual(['> b', 'run', 'echo:b', 'done', '> a', 'run', 'echo:a', 'done']);
  });

  it('never runs two sessions on a thread, even for two wakes in the same runner', async () => {
    const slow = gate();
    const { store, run, feed } = setup(() => [{ tool: 'work', until: slow.promise }]);
    await post(store, 'first');
    const draining = run('same-runner');
    await until(async () => (await feed()).includes('tool:work'));

    await post(store, 'second');
    expect(await run('same-runner')).toBe('busy');
    slow.open();
    await draining;
    expect((await feed()).filter((line) => line === 'run')).toHaveLength(2);
  });

  it('lets one runner drain at a time, and another take over an expired lease', async () => {
    const slow = gate();
    const { store, run, feed } = setup(() => [{ tool: 'work', until: slow.promise }]);
    await post(store, 'first');
    const draining = run('runner-a');
    await until(async () => (await feed()).includes('tool:work'));

    await post(store, 'second');
    expect(await run('runner-b')).toBe('busy');
    slow.open();
    await draining;
    expect(await store.pending(T)).toEqual([]);

    await store.acquireLease(T, 'dead-runner', now() + 10, now());
    await post(store, 'after a crash');
    clock += 100;
    expect(await run('runner-b')).toBe('drained');
    expect((await feed()).slice(-3)).toEqual(['tool:work', 'tool-ok', 'done']);
  });
});
