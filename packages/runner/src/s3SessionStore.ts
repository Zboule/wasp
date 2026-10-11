import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

/** Merge a session's chunks into one once there are more than this many. */
const COMPACT_AFTER = 50;
/** Chunks fetched at once on load: one by one, 50 chunks took ~1.3 s in a microVM; in parallel, ~0.1 s. */
const PARALLEL_READS = 16;

/**
 * The Agent SDK transcript, mirrored to S3 so any microVM can resume a thread.
 *
 * Bound to ONE thread: every object lives under `sessions/<threadId>/`, which is
 * the only S3 prefix the runner's thread-scoped credentials reach (CLAUDE.md,
 * invariants 3 and 4).
 *
 * Each `append` batch is its own object, so a write never rewrites history.
 * Chunk names sort by time; `load` reads them in order and drops entries whose
 * `uuid` it has seen (the SDK may replay a batch).
 *
 * A resume loads the same session twice (`getSessionInfo`, then the query), so
 * the last load is kept until the next append to that key.
 *
 *   sessions/<threadId>/<projectKey>/<sessionId>/m/<chunk>.jsonl            the main transcript
 *   sessions/<threadId>/<projectKey>/<sessionId>/s/<subpath>/<chunk>.jsonl  a subagent's
 */
export function createS3SessionStore({ client, bucket, threadId }: { client: S3Client; bucket: string; threadId: string }): SessionStore {
  let counter = 0;
  const base = (key: SessionKey) =>
    `sessions/${threadId}/${encodeURIComponent(key.projectKey)}/${encodeURIComponent(key.sessionId)}/` +
    (key.subpath ? `s/${encodeURIComponent(key.subpath)}/` : 'm/');
  const chunkName = () => `${String(Date.now()).padStart(13, '0')}-${String(++counter % 1_000_000).padStart(6, '0')}.jsonl`;

  async function list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      keys.push(...(out.Contents ?? []).map((o) => o.Key!).filter(Boolean));
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async function read(key: string): Promise<SessionStoreEntry[]> {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = (await out.Body?.transformToString()) ?? '';
    return body
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionStoreEntry);
  }

  const put = (key: string, entries: SessionStoreEntry[]) =>
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
        ContentType: 'application/x-ndjson'
      })
    );

  /** In chunk order, PARALLEL_READS at a time. */
  async function readAll(chunks: string[]): Promise<SessionStoreEntry[][]> {
    const out: SessionStoreEntry[][] = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        out[i] = await read(chunks[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, chunks.length) }, worker));
    return out;
  }

  async function loadFrom(prefix: string): Promise<SessionStoreEntry[] | null> {
    const chunks = await list(prefix);
    if (!chunks.length) return null;
    const seen = new Set<string>();
    const entries: SessionStoreEntry[] = [];
    for (const chunkEntries of await readAll(chunks)) {
      for (const entry of chunkEntries) {
        if (entry.uuid) {
          if (seen.has(entry.uuid)) continue;
          seen.add(entry.uuid);
        }
        entries.push(entry);
      }
    }
    if (chunks.length > COMPACT_AFTER) {
      // Written next to the newest chunk so it sorts after everything it replaces
      // and before anything appended later. A crash before the delete leaves
      // duplicates that the uuid check above drops.
      await put(`${chunks.at(-1)}~merged.jsonl`, entries);
      for (let i = 0; i < chunks.length; i += 1000) {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunks.slice(i, i + 1000).map((Key) => ({ Key })) } }));
      }
    }
    return entries;
  }

  /** The last load of each prefix, and how many appends each prefix has had (a load that raced an append is not kept). */
  const lastLoad = new Map<string, SessionStoreEntry[] | null>();
  const appends = new Map<string, number>();

  return {
    async append(key, entries) {
      const prefix = base(key);
      appends.set(prefix, (appends.get(prefix) ?? 0) + 1);
      lastLoad.delete(prefix);
      if (entries.length) await put(prefix + chunkName(), entries);
    },

    async load(key) {
      const prefix = base(key);
      const kept = lastLoad.get(prefix);
      if (kept !== undefined) return kept && [...kept];
      const before = appends.get(prefix) ?? 0;
      const loaded = await loadFrom(prefix);
      if ((appends.get(prefix) ?? 0) === before) lastLoad.set(prefix, loaded);
      return loaded && [...loaded];
    }
  };
}
