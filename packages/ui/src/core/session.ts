import type { CancelResult, Deliver, FeedEntry, FeedPage, QueuedMessage, ThreadState, WaspFile } from '@zboule/wasp-protocol';
import { createStore } from 'zustand/vanilla';

import { type TimelineItem, applyEvent } from './timeline.ts';

/**
 * How the UI reaches the app's API. The app checks who the user is; the only
 * thing the browser sends anywhere else is a file, to the upload URL the app
 * handed it.
 */
export interface WaspTransport {
  feed(after: string | null): Promise<FeedPage>;
  /**
   * `files`: refs from `upload`. A message with files may have no text. Resolving
   * to wasp-client's `{ messageId }` lets the chat keep the sent message in place
   * until the agent takes it.
   */
  post(text: string, deliver: Deliver, files?: string[]): Promise<unknown>;
  interrupt(): Promise<unknown>;
  /** `cancelled`, or why not: `delivered` (the agent took it first) or `missing`. */
  cancel(messageId: string): Promise<CancelResult>;
  /** Uploads one file and resolves to its ref. Without it, the chat offers no attachments. */
  upload?(file: File, onProgress?: (fraction: number) => void): Promise<string>;
  /**
   * A link that downloads the file fresh when clicked. Without it, links use the
   * URL that came with the feed, which expires a few minutes after loading.
   */
  fileHref?(file: WaspFile): string;
}

/** A message sent from this page that the feed does not show yet. */
export type OutgoingMessage = {
  key: string;
  /** Set once the API has answered. */
  messageId?: string;
  /** The queued message it takes the place of ("send now"). */
  replaces?: string;
  /** A poll has seen it in the queue: once it leaves, the agent has it. */
  queued?: boolean;
  text: string;
  deliver: Deliver;
  attachments?: WaspFile[];
};

export type WaspSessionState = {
  state: ThreadState;
  queue: QueuedMessage[];
  timeline: TimelineItem[];
  /** Sent from this page and not in the conversation yet. */
  outbox: OutgoingMessage[];
  /** A turn is running: between its RUN_STARTED and its end. */
  running: boolean;
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
  const store = createStore<WaspSessionState>(() => ({
    state: 'idle',
    queue: [],
    timeline: [],
    outbox: [],
    running: false,
    cursor: null,
    error: null,
    loaded: false
  }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;
  let sent = 0;
  // Messages the feed has shown, delivered or failed. The API can answer a post
  // after the poll that already carried its message, so this outlives one page.
  const settled = new Set<string>();
  const unsettled = (outbox: OutgoingMessage[]) => outbox.filter((o) => !o.messageId || !settled.has(o.messageId));

  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  async function poll(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const page = await transport.feed(store.getState().cursor);
        for (const id of settledIds(page.entries)) settled.add(id);
        store.setState((s) => {
          const inQueue = new Set(page.queue.map((m) => m.id));
          return {
            state: page.state,
            queue: page.queue,
            timeline: page.entries.reduce((timeline, entry) => applyEvent(timeline, entry.event, entry.cursor), s.timeline),
            // With no runner, a sent message that left the queue unseen was removed elsewhere (another tab).
            outbox: unsettled(s.outbox)
              .filter((o) => page.state !== 'idle' || !o.messageId || inQueue.has(o.messageId))
              .map((o) => (o.messageId && inQueue.has(o.messageId) ? { ...o, queued: true } : o)),
            running: page.state !== 'idle' && page.entries.reduce((r, { event }) => runningAfter(r, event), s.running),
            cursor: page.cursor,
            error: null,
            loaded: true
          };
        });
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
    timer = setTimeout(
      async () => {
        if (!hidden()) await poll();
        schedule();
      },
      busy ? activeMs : idleMs
    );
  }

  // An action usually makes the thread busy: poll now, and from now on at the busy pace.
  const afterAction = async () => {
    await poll();
    if (running) {
      if (timer) clearTimeout(timer);
      schedule();
    }
  };

  const updateOutbox = (change: (o: OutgoingMessage[]) => OutgoingMessage[]) => store.setState((s) => ({ outbox: change(s.outbox) }));

  /** Shows a message as sent before the API has it. */
  function hold(message: Omit<OutgoingMessage, 'key' | 'messageId'>): string {
    const key = `out:${++sent}`;
    updateOutbox((o) => [...o, { key, ...message }]);
    return key;
  }

  async function submit(key: string, text: string, deliver: Deliver, files: string[]) {
    let answer: unknown;
    try {
      answer = await transport.post(text, deliver, files.length ? files : undefined);
    } catch (error) {
      updateOutbox((o) => o.filter((m) => m.key !== key));
      throw error;
    }
    const messageId = messageIdOf(answer);
    if (messageId) updateOutbox((o) => unsettled(o.map((m) => (m.key === key ? { ...m, messageId } : m))));
    await afterAction();
    // Without an id there is no telling it apart in the feed: the queue shows it now.
    if (!messageId) updateOutbox((o) => o.filter((m) => m.key !== key));
  }

  /**
   * `later` by default: after the agent's current turn. The message is in
   * `outbox` straight away, and stays there until the feed shows it. Throws,
   * and takes it back out, if the API refuses it. `attachments` describe
   * `files` for that outbox entry.
   */
  async function post(text: string, deliver: Deliver = 'later', files: string[] = [], attachments?: WaspFile[]) {
    const key = hold({ text, deliver, ...(attachments?.length ? { attachments } : {}) });
    await submit(key, text, deliver, files);
  }

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
    post,
    async interrupt() {
      await transport.interrupt();
      await afterAction();
    },
    async cancel(messageId: string): Promise<CancelResult> {
      const result = await transport.cancel(messageId);
      if (result === 'cancelled') store.setState((s) => ({ outbox: s.outbox.filter((o) => o.messageId !== messageId) }));
      await afterAction();
      return result;
    },
    /**
     * Has the agent read a queued message at its next step instead of after its
     * turn: takes it out of the queue and sends it again as `asap`. `delivered`
     * or `missing`: it had left the queue already. `unsent`: it left the queue
     * but sending it again failed (the reason is in `error`), so hand it back to
     * the user.
     */
    async sendNow(message: QueuedMessage): Promise<CancelResult | 'unsent'> {
      // Held before the cancel, so the message never vanishes in between.
      const key = hold({ text: message.text, deliver: 'asap', replaces: message.id, ...(message.attachments?.length ? { attachments: message.attachments } : {}) });
      let result: CancelResult;
      try {
        result = await transport.cancel(message.id);
      } catch (error) {
        updateOutbox((o) => o.filter((m) => m.key !== key));
        throw error;
      }
      if (result !== 'cancelled') {
        updateOutbox((o) => o.filter((m) => m.key !== key));
        await afterAction();
        return result;
      }
      updateOutbox((o) => o.filter((m) => m.messageId !== message.id));
      try {
        await submit(key, message.text, 'asap', message.attachments?.map((f) => f.ref) ?? []);
      } catch (error) {
        store.setState({ error: error instanceof Error ? error.message : String(error) });
        return 'unsent';
      }
      return result;
    }
  };
}

/** Messages the agent took (`wasp.message`) or could not take (`wasp.message_failed`). */
function settledIds(entries: FeedEntry[]): string[] {
  return entries.flatMap(({ event }) => (event.type === 'CUSTOM' && 'messageId' in event.value ? [event.value.messageId] : []));
}

function runningAfter(running: boolean, event: FeedEntry['event']): boolean {
  if (event.type === 'RUN_STARTED') return true;
  if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') return false;
  return running;
}

function messageIdOf(answer: unknown): string | undefined {
  const id = (answer as { messageId?: unknown } | null)?.messageId;
  return typeof id === 'string' ? id : undefined;
}

/** Where a message not yet in the conversation shows. */
export type PendingMessage = {
  id: string;
  text: string;
  deliver: Deliver;
  attachments?: WaspFile[];
  /** The API has not answered yet: it cannot be edited or removed. */
  sending: boolean;
};

/**
 * Splits the messages not yet in the conversation by where they belong.
 * `landing`: about to be read, shown at the end of the conversation (the one a
 * new turn starts with, or the first when no turn runs). `waiting`: behind a
 * running turn, shown in the queue.
 */
export function pendingMessages(s: Pick<WaspSessionState, 'queue' | 'outbox' | 'running'>): { landing: PendingMessage[]; waiting: PendingMessage[] } {
  const inQueue = new Set(s.queue.map((m) => m.id));
  const replaced = new Set(s.outbox.flatMap((o) => (o.replaces ? [o.replaces] : [])));
  const view = (m: { text: string; deliver: Deliver; attachments?: WaspFile[] }, id: string, sending: boolean): PendingMessage => ({
    id,
    text: m.text,
    deliver: m.deliver,
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    sending
  });
  // Claimed by the runner, not yet in the feed.
  const claimed = (o: OutgoingMessage) => Boolean(o.messageId && o.queued && !inQueue.has(o.messageId));
  const landing = s.outbox.filter(claimed).map((o) => view(o, o.messageId!, false));
  const waiting = [
    ...s.queue.filter((m) => !replaced.has(m.id)).map((m) => view(m, m.id, false)),
    // Not seen in the queue yet: the API has not answered, or no poll has run since.
    ...s.outbox.filter((o) => !claimed(o) && !(o.messageId && inQueue.has(o.messageId))).map((o) => view(o, o.messageId ?? o.key, true))
  ];
  if (!s.running && landing.length === 0 && waiting.length > 0) landing.push(waiting.shift()!);
  return { landing, waiting };
}

/**
 * The default transport: the app exposes these routes for one thread and checks
 * the user on each (wasp-client underneath):
 *   GET    {base}/feed?after=<cursor>
 *   POST   {base}/messages        { text, deliver, files? }
 *   POST   {base}/interrupt
 *   DELETE {base}/queue/{messageId} → { result } or the bare result of wasp.cancel
 *   POST   {base}/uploads         { name, mediaType, size } → wasp.upload's { ref, url, fields }
 *   GET    {base}/files?ref=<ref> → a redirect to wasp.download(id, ref)
 * An API error answering `{ error }` shows that message.
 */
export function httpTransport(base: string, init: RequestInit = { credentials: 'include' }): WaspTransport {
  const call = async (path: string, options: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(typeof body?.error === 'string' ? body.error : `${options.method ?? 'GET'} ${path.split('?')[0]} → ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  };
  return {
    feed: (after) => call(`/feed${after ? `?after=${encodeURIComponent(after)}` : ''}`) as Promise<FeedPage>,
    post: (text, deliver, files) => call('/messages', { method: 'POST', body: JSON.stringify({ text, deliver, ...(files?.length ? { files } : {}) }) }),
    interrupt: () => call('/interrupt', { method: 'POST' }),
    cancel: async (messageId) => {
      const body = (await call(`/queue/${encodeURIComponent(messageId)}`, { method: 'DELETE' })) as { result?: CancelResult } | CancelResult | null;
      return (typeof body === 'string' ? body : body?.result) ?? 'missing';
    },
    async upload(file, onProgress) {
      const mediaType = file.type || 'application/octet-stream';
      // The size is signed exactly: S3 refuses a body of any other length.
      const target = (await call('/uploads', { method: 'POST', body: JSON.stringify({ name: file.name, mediaType, size: file.size }) })) as {
        ref: string;
        url: string;
        fields: Record<string, string>;
      };
      const form = new FormData();
      for (const [key, value] of Object.entries(target.fields)) form.append(key, value);
      form.append('file', file); // last: S3 ignores fields after the file
      await postWithProgress(target.url, form, onProgress);
      return target.ref;
    },
    fileHref: (file) => `${base}/files?ref=${encodeURIComponent(file.ref)}`
  };
}

/** fetch() cannot report upload progress; XMLHttpRequest can. */
function postWithProgress(url: string, body: FormData, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload refused (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.send(body);
  });
}
