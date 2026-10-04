import type { Deliver, FeedPage, QueuedMessage, ThreadState } from '@zboule/wasp-protocol';
import { createStore } from 'zustand/vanilla';

import { type TimelineItem, applyEvent } from './timeline.ts';

/** How the UI reaches the app's API. The app checks who the user is; the UI never talks to AWS. */
export interface WaspTransport {
  feed(after: string | null): Promise<FeedPage>;
  post(text: string, deliver: Deliver): Promise<unknown>;
  interrupt(): Promise<unknown>;
  cancel(messageId: string): Promise<unknown>;
}

export type WaspSessionState = {
  state: ThreadState;
  queue: QueuedMessage[];
  timeline: TimelineItem[];
  cursor: string | null;
  /** The last transport error, cleared by the next successful poll. */
  error: string | null;
  loaded: boolean;
};

export type WaspSession = ReturnType<typeof createWaspSession>;

/**
 * Follows one thread: polls its feed (fast while the agent works, slowly when it
 * is idle, not at all in a hidden tab) and exposes the actions a chat needs.
 */
export function createWaspSession(transport: WaspTransport, { activeMs = 1_000, idleMs = 5_000 } = {}) {
  const store = createStore<WaspSessionState>(() => ({ state: 'idle', queue: [], timeline: [], cursor: null, error: null, loaded: false }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;

  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  async function poll(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const page = await transport.feed(store.getState().cursor);
        store.setState((s) => ({
          state: page.state,
          queue: page.queue,
          timeline: page.entries.reduce((timeline, entry) => applyEvent(timeline, entry.event, entry.cursor), s.timeline),
          cursor: page.cursor,
          error: null,
          loaded: true
        }));
      } catch (error) {
        store.setState({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function schedule() {
    if (!running) return;
    const { state, queue } = store.getState();
    const busy = state !== 'idle' || queue.length > 0;
    timer = setTimeout(async () => {
      if (!hidden()) await poll();
      schedule();
    }, busy ? activeMs : idleMs);
  }

  const afterAction = async () => {
    await poll();
  };

  return {
    store,
    start() {
      if (running) return;
      running = true;
      void poll().then(schedule);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    refresh: poll,
    async post(text: string, deliver: Deliver = 'later') {
      await transport.post(text, deliver);
      await afterAction();
    },
    async interrupt() {
      await transport.interrupt();
      await afterAction();
    },
    async cancel(messageId: string) {
      await transport.cancel(messageId);
      await afterAction();
    }
  };
}

/**
 * The default transport: the app exposes these routes for one thread and checks
 * the user on each (wasp-client underneath):
 *   GET    {base}/feed?after=<cursor>
 *   POST   {base}/messages        { text, deliver }
 *   POST   {base}/interrupt
 *   DELETE {base}/queue/{messageId}
 */
export function httpTransport(base: string, init: RequestInit = { credentials: 'include' }): WaspTransport {
  const call = async (path: string, options: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
    if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${path} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    feed: (after) => call(`/feed${after ? `?after=${encodeURIComponent(after)}` : ''}`) as Promise<FeedPage>,
    post: (text, deliver) => call('/messages', { method: 'POST', body: JSON.stringify({ text, deliver }) }),
    interrupt: () => call('/interrupt', { method: 'POST' }),
    cancel: (messageId) => call(`/queue/${encodeURIComponent(messageId)}`, { method: 'DELETE' })
  };
}
