// S3 SessionStore adapter (Anthropic hybrid-sessions pattern). Persists the SDK
// transcript so a thread's model context survives microVM recycling: when a
// dormant thread's next message lands on a fresh microVM, the SDK loads the
// prior transcript from here and resumes.
//
// Strategy: one JSONL object per session, rewritten on each ~100ms append batch.
// The in-memory accumulator is seeded from S3 on first append (so we never
// overwrite prior history with just a delta), and uuid is the idempotency key
// (retries and replays do not duplicate). One run per thread is enforced by the
// consumer, so there are no concurrent writers to a session.
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export function createS3SessionStore({ bucket, prefix = 'sessions', region, log }) {
  const s3 = new S3Client({ region });
  const acc = new Map();   // baseKey -> { entries: [], seen: Set<uuid> }
  const P = prefix.replace(/\/$/, '');

  const baseKey = (k) => `${k.projectKey}/${k.sessionId}${k.subpath ? '/' + k.subpath : ''}`;
  const objKey = (k) => `${P}/${baseKey(k)}.jsonl`;

  async function readObject(k) {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objKey(k) }));
      const body = await r.Body.transformToString();
      return body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async function ensureLoaded(k) {
    const bk = baseKey(k);
    if (acc.has(bk)) return acc.get(bk);
    const existing = (await readObject(k)) || [];
    const seen = new Set(existing.map((e) => e.uuid).filter(Boolean));
    const state = { entries: existing, seen };
    acc.set(bk, state);
    return state;
  }

  return {
    async load(key) {
      const state = await ensureLoaded(key);
      return state.entries.length ? state.entries : null;
    },
    async append(key, entries) {
      const state = await ensureLoaded(key);
      let changed = false;
      for (const e of entries) {
        if (e.uuid && state.seen.has(e.uuid)) continue;
        if (e.uuid) state.seen.add(e.uuid);
        state.entries.push(e);
        changed = true;
      }
      if (!changed) return;
      const body = state.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objKey(key), Body: body, ContentType: 'application/x-ndjson' }));
      log?.(`sessionstore: mirrored ${state.entries.length} entries -> ${objKey(key)}`);
    },
  };
}
