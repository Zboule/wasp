import type { CancelResult, Deliver, FeedPage, QueuedMessage, ThreadState, WaspFile } from '@zboule/wasp-protocol';
import { createStore } from 'zustand/vanilla';

import { type TimelineItem, applyEvent } from './timeline.ts';

/**
 * How the UI reaches the app's API. The app checks who the user is; the only
 * thing the browser sends anywhere else is a file, to the upload URL the app
 * handed it.
 */
export interface WaspTransport {
  feed(after: string | null): Promise<FeedPage>;
  /** `files`: refs from `upload`. A message with files may have no text. */
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
    /** `asap` by default: the agent reads it at its next step, without being stopped. */
    async post(text: string, deliver: Deliver = 'asap', files: string[] = []) {
      await transport.post(text, deliver, files.length ? files : undefined);
      await afterAction();
    },
    async interrupt() {
      await transport.interrupt();
      await afterAction();
    },
    async cancel(messageId: string): Promise<CancelResult> {
      const result = await transport.cancel(messageId);
      await afterAction();
      return result;
    }
  };
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
