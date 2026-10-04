import type { Deliver, FeedEntry } from '@zboule/wasp-protocol';
import { describe, expect, it } from 'vitest';

import { drain } from './drain.ts';
import { type ThreadStore, createMemoryStore } from '@zboule/wasp-store';
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

function setup(script?: Script, extra: Partial<Parameters<typeof drain>[1]> = {}) {
  const store = createMemoryStore();
  const { agent, sent } = scriptedAgent(script);
  const run = (owner = 'runner-a') => drain(T, { store, agent, owner, now, pollMs: 2, leaseMs: 1_000, ...extra });
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
      '> first',
      'run',
      'tool:work',
      'tool-ok',
      'first done',
      'done',
      '> second',
      'run',
      'echo:second',
      'done',
      '> third',
      'run',
      'echo:third',
      'done'
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
    const { store, run, feed } = setup((text) => (text === 'first' ? [{ tool: 'work', until: never.promise }] : [{ say: `echo:${text}` }]));
    await post(store, 'first');
    const draining = run();
    await until(async () => (await feed()).includes('tool:work'));

    await post(store, 'queued later');
    await post(store, 'stop, do this', 'now');
    await draining;

    expect(await feed()).toEqual([
      '> first',
      'run',
      'tool:work',
      'tool-failed',
      'interrupted',
      '> stop, do this',
      'run',
      'echo:stop, do this',
      'done',
      '> queued later',
      'run',
      'echo:queued later',
      'done'
    ]);
  });

  it('honours an interrupt request and carries on with the queue', async () => {
    const never = gate();
    const { store, run, feed } = setup((text) => (text === 'first' ? [{ tool: 'work', until: never.promise }] : [{ say: `echo:${text}` }]));
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

  it('ignores an interrupt asked for while nothing ran', async () => {
    const { store, run, feed } = setup();
    await store.requestInterrupt(T, now());
    await post(store, 'hello');
    await run();
    expect(await feed()).toEqual(['> hello', 'run', 'echo:hello', 'done']);
  });

  it('moves an oversized tool result out of the feed, keeping a preview and a reference', async () => {
    const store = createMemoryStore();
    const big = 'x'.repeat(200_000);
    const { agent } = scriptedAgent(() => [{ tool: 'scrape', output: big }]);
    const offloaded: string[] = [];
    await post(store, 'scrape it');
    await drain(T, {
      store,
      agent,
      owner: 'r',
      now,
      pollMs: 2,
      offload: async (_thread, content) => {
        offloaded.push(content);
        return 'payloads/thread-1/ref-1';
      }
    });
    const result = (await store.feed(T)).map((e) => e.event).find((e) => e.type === 'TOOL_CALL_RESULT');
    expect(offloaded).toEqual([big]);
    expect(result).toMatchObject({ outputRef: 'payloads/thread-1/ref-1' });
    expect(result?.type === 'TOOL_CALL_RESULT' && result.content.length).toBeLessThan(3_000);
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

  it('restores the thread’s files when it opens, and fetches a message’s files before claiming it', async () => {
    const file = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      name: 'q3.pdf',
      mediaType: 'application/pdf',
      size: 2_200_000,
      ref: 'payloads/x/files/f/q3.pdf'
    };
    const store = createMemoryStore();
    const { agent, sent } = scriptedAgent();
    const order: string[] = [];
    const claim = store.claim.bind(store);
    store.claim = async (...args) => (order.push('claim'), claim(...args));
    await store.enqueue(T, { id: 'm-1', text: 'summarise this', deliver: 'later', createdAt: now(), attachments: [file] });

    const files = {
      restoreAll: async () => void order.push('restore'),
      fetch: async (f: { name: string }[]) => void order.push(`fetch:${f.map((x) => x.name)}`)
    };
    await drain(T, { store, agent, owner: 'r', now, pollMs: 2, files });

    expect(order).toEqual(['restore', 'fetch:q3.pdf', 'claim']);
    expect(sent[0]?.text).toBe(`summarise this\n\n[The user attached a file, in your working directory:\n- files/${file.id}/q3.pdf (application/pdf, 2.1 MB)]`);
    const delivered = (await store.feed(T)).map((e) => e.event).find((e) => e.type === 'CUSTOM');
    expect(delivered).toMatchObject({ value: { text: 'summarise this', attachments: [file] } });
  });

  describe('caller identity', () => {
    async function postAs(store: ThreadStore, text: string, principal: string, deliver: Deliver = 'later') {
      return store.enqueue(T, { id: `m-${text}`, text, deliver, createdAt: now(), principal, callerToken: `cipher(${principal})` });
    }
    /** What the MCP calls would carry at each delivery: the useCaller hook, as the runner wires it. */
    function identities() {
      const tokens: (string | undefined)[] = [];
      const useCaller = async (m: { callerToken?: string }) => {
        if (m.callerToken === 'cipher(broken)') return { ok: false as const, reason: 'invalid' as const };
        tokens.push(m.callerToken);
        return { ok: true as const };
      };
      return { tokens, useCaller };
    }

    it('lets an asap message of the same principal join the turn, and holds another principal’s for the next turn', async () => {
      const slow = gate();
      const { tokens, useCaller } = identities();
      const { store, sent, run, feed } = setup(
        (text) => (text === 'review' ? [{ tool: 'work', until: slow.promise }, { say: 'reviewed' }] : [{ say: `echo:${text}` }]),
        { useCaller }
      );
      await postAs(store, 'review', 'reviewer');
      const draining = run();
      await until(async () => (await feed()).includes('tool:work'));

      await postAs(store, 'admin says', 'admin:1', 'asap');
      await postAs(store, 'reviewer adds', 'reviewer', 'asap');
      await until(async () => sent.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent.map((m) => m.text)).toEqual(['review', 'reviewer adds']);

      slow.open();
      await draining;
      expect(await feed()).toEqual([
        '> review',
        'run',
        'tool:work',
        '> reviewer adds',
        'tool-ok',
        'ack:reviewer adds',
        'reviewed',
        'done',
        '> admin says',
        'run',
        'echo:admin says',
        'done'
      ]);
      // Each delivery switched the credential to its own message's token, before it reached the agent.
      expect(tokens).toEqual(['cipher(reviewer)', 'cipher(reviewer)', 'cipher(admin:1)']);
    });

    it('fails a message whose token cannot be used, without showing it to the agent, and goes on', async () => {
      const { useCaller } = identities();
      const { store, sent, run, feed } = setup(undefined, { useCaller });
      await postAs(store, 'bad', 'broken');
      await post(store, 'fine');
      await run();
      expect(sent.map((m) => m.text)).toEqual(['fine']);
      expect(await feed()).toEqual(['! wasp.message_failed', '> fine', 'run', 'echo:fine', 'done']);
      expect(await store.pending(T)).toEqual([]);
    });

    it('never writes a caller token to the feed', async () => {
      const { useCaller } = identities();
      const { store, run } = setup(undefined, { useCaller });
      await postAs(store, 'hello', 'user:1');
      await run();
      expect(JSON.stringify(await store.feed(T))).not.toContain('cipher(');
    });

    it('closes the session when the first delivery throws', async () => {
      const { store, sent, run } = setup(undefined, {
        useCaller: async () => {
          throw new Error('KMS unreachable');
        }
      });
      await postAs(store, 'hello', 'user:1');
      await expect(run()).rejects.toThrow('KMS unreachable');
      expect(sent).toEqual([]);
      expect(await store.leaseHolder(T, now())).toBeNull();
    });
  });
});
