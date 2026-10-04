import { type CancelResult, type Deliver, type FeedEntry, type FeedEvent, type FeedPage, type ThreadStore, threadState } from '@zboule/wasp-protocol';

/** Everything the client needs, injected so the core is testable without AWS. */
export type WaspClientDeps = {
  store: ThreadStore;
  /** Encrypts a caller token so that only this thread's runner can decrypt it (KMS, encryption context `{ threadId }`). */
  encryptToken(threadId: string, token: string): Promise<string>;
  /** Turns a stored payload reference (`payloads/<threadId>/…`) into a short-lived URL. */
  presign(ref: string): Promise<string>;
  /** Deletes a thread's transcript and payloads. */
  deleteObjects(threadId: string): Promise<void>;
  now?: () => number;
};

export type PostOptions = {
  text: string;
  /** `later` (default) waits for the current turn, `asap` joins it at the next tool boundary, `now` interrupts it. */
  deliver?: Deliver;
  /** The user's token for MCP servers declared `auth: "caller"`. Encrypted before it is stored. */
  callerToken?: string;
};

export interface WaspClient {
  post(threadId: string, options: PostOptions): Promise<{ messageId: string; position: number }>;
  feed(threadId: string, options?: { after?: string | null; limit?: number }): Promise<FeedPage>;
  interrupt(threadId: string): Promise<void>;
  cancel(threadId: string, messageId: string): Promise<CancelResult>;
  deleteThread(threadId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 100_000;
/** A queue left waiting this long with no runner is woken again. */
const STALLED_AFTER_MS = 30_000;

/**
 * The client checks no permissions. Call it only for threads the current user
 * may access: thread ownership is the app's job, not wasp's.
 */
export function createWaspClientWith(deps: WaspClientDeps): WaspClient {
  const { store } = deps;
  const now = deps.now ?? Date.now;

  const checkThread = (threadId: string) => {
    if (!UUID.test(threadId)) throw new Error('wasp: a thread id must be a UUID');
  };

  const resolveRefs = async (entry: FeedEntry): Promise<FeedEntry> => {
    const event: FeedEvent = entry.event;
    if (event.type === 'TOOL_CALL_RESULT' && event.outputRef) return { ...entry, event: { ...event, outputRef: await deps.presign(event.outputRef) } };
    if (event.type === 'TOOL_CALL_ARGS' && event.argsRef) return { ...entry, event: { ...event, argsRef: await deps.presign(event.argsRef) } };
    return entry;
  };

  return {
    async post(threadId, { text, deliver = 'later', callerToken }) {
      checkThread(threadId);
      if (!text.trim()) throw new Error('wasp: a message needs text');
      if (text.length > MAX_TEXT) throw new Error(`wasp: a message is limited to ${MAX_TEXT} characters`);
      const messageId = crypto.randomUUID();
      await store.enqueue(threadId, {
        id: messageId,
        text,
        deliver,
        createdAt: now(),
        ...(callerToken ? { callerToken: await deps.encryptToken(threadId, callerToken) } : {})
      });
      const position = (await store.pending(threadId)).findIndex((m) => m.id === messageId);
      return { messageId, position };
    },

    async feed(threadId, { after = null, limit } = {}) {
      checkThread(threadId);
      const at = now();
      const [entries, pending, holder] = await Promise.all([
        store.feed(threadId, { after, ...(limit ? { limit } : {}) }),
        store.pending(threadId),
        store.leaseHolder(threadId, at)
      ]);
      const oldest = Math.min(...pending.map((m) => m.createdAt));
      if (!holder && pending.length && at - oldest > STALLED_AFTER_MS) {
        await store.requestWake(threadId, at, STALLED_AFTER_MS);
      }
      return {
        state: threadState({ leaseHeld: holder !== null, queued: pending.length }),
        queue: pending.map(({ id, text, deliver, createdAt }) => ({ id, text, deliver, createdAt })),
        entries: await Promise.all(entries.map(resolveRefs)),
        cursor: entries.at(-1)?.cursor ?? after
      };
    },

    async interrupt(threadId) {
      checkThread(threadId);
      await store.requestInterrupt(threadId, now());
    },

    async cancel(threadId, messageId) {
      checkThread(threadId);
      return store.cancel(threadId, messageId);
    },

    async deleteThread(threadId) {
      checkThread(threadId);
      await Promise.all([store.deleteThread(threadId), deps.deleteObjects(threadId)]);
    }
  };
}
