import type { FeedEntry, FeedPage } from '@zboule/wasp-protocol';
import { describe, expect, it, vi } from 'vitest';

import { type WaspTransport, createWaspSession, httpTransport } from './session.ts';
import { applyEvent } from './timeline.ts';

const entry = (cursor: string, event: FeedEntry['event']): FeedEntry => ({ cursor, at: 0, event });

describe('applyEvent', () => {
  it('builds the conversation: user message, assistant text, a tool with its full result', () => {
    const events: FeedEntry['event'][] = [
      { type: 'CUSTOM', name: 'wasp.message', value: { messageId: 'm1', text: 'hi', deliver: 'later' } },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Hello ' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: '<b>there</b>' },
      { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'Bash' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"command":"ls"}' },
      { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 't1', content: 'preview…', outputRef: 'https://signed/x' },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r', result: { outcome: 'interrupted' } }
    ];
    const timeline = events.reduce((t, e, i) => applyEvent(t, e, String(i)), [] as ReturnType<typeof applyEvent>);
    expect(timeline).toEqual([
      { kind: 'user', id: 'm1', text: 'hi', deliver: 'later' },
      { kind: 'assistant', id: 'a1', text: 'Hello <b>there</b>' },
      { kind: 'tool', id: 't1', name: 'Bash', args: '{"command":"ls"}', status: 'done', result: 'preview…', resultUrl: 'https://signed/x' },
      { kind: 'notice', id: '7', code: 'interrupted' }
    ]);
  });
});

describe('a run that ends', () => {
  it('stops the tools that never answered', () => {
    const events: FeedEntry['event'][] = [
      { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'Bash' },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r', result: { outcome: 'interrupted' } }
    ];
    const timeline = events.reduce((t, e, i) => applyEvent(t, e, String(i)), [] as ReturnType<typeof applyEvent>);
    expect(timeline[0]).toMatchObject({ kind: 'tool', status: 'stopped' });
  });
});

describe('createWaspSession', () => {
  function fakeTransport(pages: FeedPage[]) {
    const calls: string[] = [];
    const transport: WaspTransport = {
      async feed(after) {
        calls.push(`feed:${after}`);
        return pages.shift() ?? { state: 'idle', queue: [], entries: [], cursor: after };
      },
      async post(text, deliver) {
        calls.push(`post:${deliver}:${text}`);
      },
      async interrupt() {
        calls.push('interrupt');
      },
      async cancel(id) {
        calls.push(`cancel:${id}`);
        return 'cancelled';
      }
    };
    return { transport, calls };
  }

  it('reads the feed from where it left off, and refreshes after each action', async () => {
    const { transport, calls } = fakeTransport([
      {
        state: 'working',
        queue: [{ id: 'q1', text: 'later one', deliver: 'later', createdAt: 1 }],
        entries: [entry('c1', { type: 'CUSTOM', name: 'wasp.message', value: { messageId: 'm1', text: 'hi', deliver: 'later' } })],
        cursor: 'c1'
      }
    ]);
    const session = createWaspSession(transport);
    await session.refresh();
    expect(session.store.getState()).toMatchObject({ state: 'working', cursor: 'c1', loaded: true, queue: [{ id: 'q1' }] });

    await session.post('stop that', 'now');
    expect(await session.cancel('q1')).toBe('cancelled');
    await session.interrupt();
    await session.post('by default');
    expect(calls).toEqual(['feed:null', 'post:now:stop that', 'feed:c1', 'cancel:q1', 'feed:c1', 'interrupt', 'feed:c1', 'post:asap:by default', 'feed:c1']);
  });

  it('keeps what it has when the API fails, and says so', async () => {
    const session = createWaspSession({
      feed: async () => {
        throw new Error('GET /feed → 401');
      },
      post: async () => undefined,
      interrupt: async () => undefined,
      cancel: async () => 'missing'
    });
    await session.refresh();
    expect(session.store.getState()).toMatchObject({ error: 'GET /feed → 401', loaded: false, timeline: [] });
  });
});

describe('polling pace', () => {
  it('switches to the busy pace right after a message is sent', async () => {
    vi.useFakeTimers();
    try {
      let busy = false;
      let feeds = 0;
      const session = createWaspSession(
        {
          feed: async (after) => {
            feeds++;
            return { state: busy ? 'waking_up' : 'idle', queue: [], entries: [], cursor: after };
          },
          post: async () => {
            busy = true;
          },
          interrupt: async () => undefined,
          cancel: async () => 'missing'
        },
        { activeMs: 1_000, idleMs: 5_000 }
      );
      session.start();
      await vi.advanceTimersByTimeAsync(0);
      await session.post('hi');
      const after = feeds;
      await vi.advanceTimersByTimeAsync(1_100);
      expect(feeds).toBeGreaterThan(after);
      session.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('httpTransport', () => {
  it('reads the cancel result whether the API wraps it or not', async () => {
    const answers: unknown[] = [{ result: 'cancelled' }, 'delivered', {}];
    const fetchMock = async () => new Response(JSON.stringify(answers.shift()), { status: 200 });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const transport = httpTransport('/api/threads/t');
      expect(await transport.cancel('a')).toBe('cancelled');
      expect(await transport.cancel('b')).toBe('delivered');
      expect(await transport.cancel('c')).toBe('missing');
    } finally {
      globalThis.fetch = original;
    }
  });
});
