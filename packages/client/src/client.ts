import {
  type CancelResult,
  type Deliver,
  type FeedEntry,
  type FeedEvent,
  type FeedPage,
  type ThreadStore,
  type WaspFile,
  fileRef,
  parseFileRef,
  threadState
} from '@zboule/wasp-protocol';

/** Everything the client needs, injected so the core is testable without AWS. */
export type WaspClientDeps = {
  store: ThreadStore;
  /** Encrypts a caller token so that only this thread's runner can decrypt it (KMS, encryption context `{ threadId }`). */
  encryptToken(threadId: string, token: string): Promise<string>;
  /** Turns a stored payload reference (`payloads/<threadId>/…`) into a short-lived URL; with `download`, one that saves the file under that name. */
  presign(ref: string, options?: { download?: string }): Promise<string>;
  /** A short-lived S3 POST that accepts exactly one object at `ref`, of this type and at most `maxBytes`. */
  presignUpload(ref: string, options: { mediaType: string; maxBytes: number }): Promise<{ url: string; fields: Record<string, string> }>;
  /** What S3 holds at `ref`, or null when nothing was uploaded there. */
  headObject(ref: string): Promise<{ size: number; mediaType: string } | null>;
  limits?: Partial<FileLimits>;
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
  /** Refs returned by `upload`, once each file is uploaded. A message with files may have no text. */
  files?: string[];
};

export type FileLimits = { maxFileBytes: number; maxFiles: number };
export const DEFAULT_FILE_LIMITS: FileLimits = { maxFileBytes: 25 * 1024 * 1024, maxFiles: 10 };

export type UploadOptions = { name: string; mediaType?: string; size: number };
/** POST `fields` then the file (last) as multipart form data to `url`, then pass `ref` to `post`. */
export type Upload = { ref: string; url: string; fields: Record<string, string> };

export interface WaspClient {
  /** Where the browser uploads one file, straight to S3. Nothing is attached until `post` names its ref. */
  upload(threadId: string, options: UploadOptions): Promise<Upload>;
  post(threadId: string, options: PostOptions): Promise<{ messageId: string; position: number }>;
  feed(threadId: string, options?: { after?: string | null; limit?: number }): Promise<FeedPage>;
  interrupt(threadId: string): Promise<void>;
  cancel(threadId: string, messageId: string): Promise<CancelResult>;
  deleteThread(threadId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 100_000;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
/** A queue left waiting this long with no runner is woken again. */
const STALLED_AFTER_MS = 30_000;

/**
 * The client checks no permissions. Call it only for threads the current user
 * may access: thread ownership is the app's job, not wasp's.
 */
export function createWaspClientWith(deps: WaspClientDeps): WaspClient {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const limits = { ...DEFAULT_FILE_LIMITS, ...deps.limits };

  const checkThread = (threadId: string) => {
    if (!UUID.test(threadId)) throw new Error('wasp: a thread id must be a UUID');
  };

  const withUrls = (files: WaspFile[] | undefined) =>
    files && Promise.all(files.map(async (f) => ({ ...f, url: await deps.presign(f.ref, { download: f.name }) })));

  /** Size and type come from what S3 holds, not from what the caller claimed at upload. */
  const attach = async (threadId: string, refs: string[]): Promise<WaspFile[]> => {
    const unique = [...new Set(refs)];
    if (unique.length > limits.maxFiles) throw new Error(`wasp: a message is limited to ${limits.maxFiles} files`);
    return Promise.all(
      unique.map(async (ref) => {
        const parsed = parseFileRef(threadId, ref);
        if (!parsed) throw new Error('wasp: not a file of this thread');
        const head = await deps.headObject(ref);
        if (!head) throw new Error(`wasp: ${parsed.name} was not uploaded`);
        return { id: parsed.id, name: parsed.name, mediaType: head.mediaType, size: head.size, ref };
      })
    );
  };

  const resolveRefs = async (entry: FeedEntry): Promise<FeedEntry> => {
    const event: FeedEvent = entry.event;
    if (event.type === 'CUSTOM' && event.name === 'wasp.message' && event.value.attachments) {
      return { ...entry, event: { ...event, value: { ...event.value, attachments: await withUrls(event.value.attachments) } } };
    }
    if (event.type === 'TOOL_CALL_RESULT' && event.outputRef) return { ...entry, event: { ...event, outputRef: await deps.presign(event.outputRef) } };
    if (event.type === 'TOOL_CALL_ARGS' && event.argsRef) return { ...entry, event: { ...event, argsRef: await deps.presign(event.argsRef) } };
    return entry;
  };

  return {
    async upload(threadId, { name, mediaType, size }) {
      checkThread(threadId);
      if (!Number.isInteger(size) || size < 0) throw new Error('wasp: a file size is a byte count');
      if (size > limits.maxFileBytes) throw new Error(`wasp: a file is limited to ${limits.maxFileBytes} bytes`);
      const type = mediaType && MEDIA_TYPE.test(mediaType) ? mediaType.toLowerCase() : 'application/octet-stream';
      const ref = fileRef(threadId, crypto.randomUUID(), name);
      return { ref, ...(await deps.presignUpload(ref, { mediaType: type, maxBytes: limits.maxFileBytes })) };
    },

    async post(threadId, { text, deliver = 'later', callerToken, files = [] }) {
      checkThread(threadId);
      if (!text.trim() && files.length === 0) throw new Error('wasp: a message needs text or files');
      if (text.length > MAX_TEXT) throw new Error(`wasp: a message is limited to ${MAX_TEXT} characters`);
      const attachments = files.length ? await attach(threadId, files) : [];
      const messageId = crypto.randomUUID();
      await store.enqueue(threadId, {
        id: messageId,
        text,
        deliver,
        createdAt: now(),
        ...(attachments.length ? { attachments } : {}),
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
        queue: await Promise.all(
          pending.map(async ({ id, text, deliver, createdAt, attachments }) => ({
            id,
            text,
            deliver,
            createdAt,
            ...(attachments ? { attachments: await withUrls(attachments) } : {})
          }))
        ),
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
