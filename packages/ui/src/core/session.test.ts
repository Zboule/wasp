import type { FeedEntry, FeedPage } from '@zboule/wasp-protocol';
import { describe, expect, it, vi } from 'vitest';

import { type WaspSessionState, type WaspTransport, createWaspSession, httpTransport, pendingMessages } from './session.ts';
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
    expect(calls).toEqual(['feed:null', 'post:now:stop that', 'feed:c1', 'cancel:q1', 'feed:c1', 'interrupt', 'feed:c1', 'post:later:by default', 'feed:c1']);
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

describe('a message on its way', () => {
  const message = (messageId: string, text: string): FeedEntry['event'] => ({ type: 'CUSTOM', name: 'wasp.message', value: { messageId, text, deliver: 'later' } });

  /** A thread whose API answers when told to, and whose feed is set by the test. */
  function thread() {
    let page: FeedPage = { state: 'idle', queue: [], entries: [], cursor: null };
    let answer: (() => void) | null = null;
    let refuse: ((error: Error) => void) | null = null;
    const posts: string[] = [];
    const transport: WaspTransport = {
      feed: async (after) => {
        const out = page;
        page = { ...page, entries: [], cursor: page.cursor ?? after };
        return out;
      },
      post: (text, deliver) =>
        new Promise((resolve, reject) => {
          posts.push(`${deliver}:${text}`);
          answer = () => resolve({ messageId: `id:${text}`, position: 0 });
          refuse = reject;
        }),
      interrupt: async () => undefined,
      cancel: async () => 'cancelled'
    };
    return {
      transport,
      posts,
      setPage: (next: Partial<FeedPage>) => (page = { ...page, ...next }),
      answer: () => answer!(),
      refuse: (error: Error) => refuse!(error)
    };
  }

  it('shows at once, lands in the conversation, and is never shown twice', async () => {
    const t = thread();
    const session = createWaspSession(t.transport);
    await session.refresh();

    const sent = session.post('hello');
    // Before the API has answered: in the conversation, being sent.
    expect(pendingMessages(session.store.getState())).toEqual({ landing: [{ id: 'out:1', text: 'hello', deliver: 'later', sending: true }], waiting: [] });

    t.setPage({ state: 'waking_up', queue: [{ id: 'id:hello', text: 'hello', deliver: 'later', createdAt: 1 }] });
    t.answer();
    await sent;
    expect(pendingMessages(session.store.getState()).landing).toEqual([{ id: 'id:hello', text: 'hello', deliver: 'later', sending: false }]);

    // Claimed, the feed not showing it yet: it stays where it was.
    t.setPage({ state: 'working', queue: [] });
    await session.refresh();
    expect(pendingMessages(session.store.getState()).landing.map((m) => m.id)).toEqual(['id:hello']);

    t.setPage({ entries: [entry('c1', message('id:hello', 'hello'))], cursor: 'c1' });
    await session.refresh();
    const state = session.store.getState();
    expect(state.outbox).toEqual([]);
    expect(state.timeline).toEqual([{ kind: 'user', id: 'id:hello', text: 'hello', deliver: 'later' }]);
  });

  it('forgets a message the feed showed before the API answered', async () => {
    const t = thread();
    const session = createWaspSession(t.transport);
    const sent = session.post('quick');
    t.setPage({ state: 'working', entries: [entry('c1', message('id:quick', 'quick'))], cursor: 'c1' });
    await session.refresh();
    t.answer();
    await sent;
    expect(session.store.getState().outbox).toEqual([]);
  });

  it('takes a refused message back out, and says why', async () => {
    const t = thread();
    const session = createWaspSession(t.transport);
    const sent = session.post('nope');
    t.refuse(new Error('wasp: a message is limited to 100000 characters'));
    await expect(sent).rejects.toThrow('limited');
    expect(session.store.getState().outbox).toEqual([]);
  });
});

describe('pendingMessages', () => {
  const queued = (id: string, deliver: 'later' | 'asap' = 'later') => ({ id, text: id, deliver, createdAt: 1 });
  const state = (s: Partial<WaspSessionState>) => ({ queue: [], outbox: [], running: false, ...s });

  it('queues behind a running turn', () => {
    expect(pendingMessages(state({ running: true, queue: [queued('a'), queued('b')] }))).toMatchObject({ landing: [], waiting: [{ id: 'a' }, { id: 'b' }] });
  });

  it('lands the message the next turn starts with, the others still wait', () => {
    expect(pendingMessages(state({ queue: [queued('a'), queued('b')] }))).toMatchObject({ landing: [{ id: 'a' }], waiting: [{ id: 'b' }] });
    // Claimed by the runner: that one lands, the queue waits.
    const claimed = { key: 'out:1', messageId: 'c', text: 'c', deliver: 'later' as const, queued: true };
    expect(pendingMessages(state({ queue: [queued('a')], outbox: [claimed] }))).toMatchObject({ landing: [{ id: 'c' }], waiting: [{ id: 'a' }] });
  });

  it('keeps a message the API just took in the queue until a poll has seen it there', () => {
    const answered = { key: 'out:1', messageId: 'b', text: 'b', deliver: 'later' as const };
    expect(pendingMessages(state({ running: true, queue: [queued('a')], outbox: [answered] }))).toMatchObject({
      landing: [],
      waiting: [{ id: 'a' }, { id: 'b', sending: true }]
    });
  });
});

describe('sendNow', () => {
  const later = { id: 'q1', text: 'also this', deliver: 'later' as const, createdAt: 1 };

  function transport(cancel: 'cancelled' | 'delivered', post?: () => Promise<unknown>) {
    const calls: string[] = [];
    const ids = ['q1', 'q2'];
    let queue: (typeof later)[] = [];
    post ??= async () => {
      const messageId = ids.shift()!;
      if (messageId === 'q1') queue = [later];
      return { messageId };
    };
    const t: WaspTransport = {
      feed: async (after) => ({ state: 'working', queue, entries: [], cursor: after }),
      post: async (text, deliver) => {
        calls.push(`post:${deliver}:${text}`);
        return post();
      },
      interrupt: async () => undefined,
      cancel: async (id) => {
        calls.push(`cancel:${id}`);
        if (cancel === 'cancelled') queue = [];
        return cancel;
      }
    };
    return { t, calls };
  }

  it('sends a queued message again for the next step, without it ever leaving the queue view', async () => {
    const { t, calls } = transport('cancelled');
    const session = createWaspSession(t);
    await session.post('also this');
    const done = session.sendNow(later);
    // Replaced by itself, being sent: never two rows, never none.
    expect(pendingMessages({ ...session.store.getState(), running: true }).waiting).toEqual([{ id: 'out:2', text: 'also this', deliver: 'asap', sending: true }]);
    expect(await done).toBe('cancelled');
    expect(calls).toEqual(['post:later:also this', 'cancel:q1', 'post:asap:also this']);
    // The message as first sent is gone too: only its asap copy remains.
    expect(session.store.getState().outbox.map((o) => o.messageId)).toEqual(['q2']);
  });

  it('does nothing when the agent took it first', async () => {
    const { t, calls } = transport('delivered');
    const session = createWaspSession(t);
    expect(await session.sendNow(later)).toBe('delivered');
    expect(calls).toEqual(['cancel:q1']);
    expect(session.store.getState().outbox).toEqual([]);
  });

  it('says so when it left the queue but could not be sent again', async () => {
    const { t } = transport('cancelled', async () => {
      throw new Error('POST /messages → 500');
    });
    const session = createWaspSession(t);
    expect(await session.sendNow(later)).toBe('unsent');
    expect(session.store.getState()).toMatchObject({ outbox: [], error: 'POST /messages → 500' });
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

describe('files', () => {
  it('puts a message’s files on its turn', () => {
    const file = { id: 'f1', name: 'notes.txt', mediaType: 'text/plain', size: 12, ref: 'payloads/t/files/f1/notes.txt', url: 'https://s3/x' };
    const [turn] = applyEvent([], { type: 'CUSTOM', name: 'wasp.message', value: { messageId: 'm1', text: '', deliver: 'later', attachments: [file] } }, 'c1');
    expect(turn).toEqual({ kind: 'user', id: 'm1', text: '', deliver: 'later', attachments: [file] });
  });

  it('posts file refs, links files through the app, and shows the API’s own error', async () => {
    const calls: { url: string; body?: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
      return url.endsWith('/messages') && calls.length > 1
        ? new Response(JSON.stringify({ error: 'wasp: notes.txt was not uploaded' }), { status: 400 })
        : new Response(JSON.stringify({ messageId: 'm', position: 0 }), { status: 201 });
    }) as typeof fetch;
    try {
      const transport = httpTransport('/api/threads/t');
      await transport.post('see attached', 'asap', ['payloads/t/files/f1/notes.txt']);
      expect(JSON.parse(calls[0]!.body!)).toEqual({ text: 'see attached', deliver: 'asap', files: ['payloads/t/files/f1/notes.txt'] });
      await expect(transport.post('again', 'asap', ['x'])).rejects.toThrow('wasp: notes.txt was not uploaded');
      expect(transport.fileHref!({ id: 'f1', name: 'n', mediaType: 'text/plain', size: 1, ref: 'payloads/t/files/f1/n' })).toBe(
        '/api/threads/t/files?ref=payloads%2Ft%2Ffiles%2Ff1%2Fn'
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
