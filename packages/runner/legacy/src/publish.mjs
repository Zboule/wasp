// Batched event publisher. Keeps wasp-backend generic: the container knows only a
// callback URL + shared secret (from env). It POSTs turn events to a consumer's
// ingest endpoint (Petit Songe), which persists them and fans them out to viewers.
//
// This is the out-of-band delivery path proven by spike #1: the invoker can
// disconnect and the container keeps running the turn and publishing here.
// Events are batched (~150ms / 25-event cadence) with a monotonic cursor and a
// final done=true flush, so ordering is preserved and request volume stays sane.

async function postWithRetry(url, secret, body, log) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body,
      });
      if (r.ok) return true;
      log?.(`publish HTTP ${r.status} (attempt ${attempt})`);
    } catch (e) {
      log?.(`publish error ${String(e?.message || e)} (attempt ${attempt})`);
    }
    await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  return false;
}

export function createPublisher({ url, secret, threadId, runId, userId, log }) {
  const queue = [];
  let cursor = 0;
  let timer = null;
  let chain = Promise.resolve();
  let closed = false;

  function flush(done = false) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length && !done) return chain;
    const events = queue.splice(0, queue.length);
    const from = cursor;
    cursor += events.length;
    const body = JSON.stringify({ threadId, runId, userId, from, events, done });
    chain = chain.then(() => postWithRetry(url, secret, body, log));
    return chain;
  }
  function schedule() { if (!timer) timer = setTimeout(() => flush(), 150); }

  return {
    emit(ev) {
      if (closed) return;
      queue.push(ev);
      if (queue.length >= 25) flush();
      else schedule();
    },
    async close() {
      closed = true;
      await flush(true);
    },
  };
}
