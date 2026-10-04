import type { Agent, AgentSession } from './agent.ts';
import { toFeedEvents } from './feed.ts';
import type { StoredMessage, ThreadStore } from './store.ts';

export type DrainDeps = {
  store: ThreadStore;
  agent: Agent;
  /** Identifies this runner (microVM). Each drain call adds its own token, so two drains in one process never share a lease. */
  owner: string;
  now?: () => number;
  newId?: () => string;
  /** How long a lease lasts without renewal. A dead runner frees the thread after this. */
  leaseMs?: number;
  /** How often a running turn looks for asap/now messages and interrupt requests. */
  pollMs?: number;
};

/**
 * Drains a thread's queue: delivers its messages to the agent in order, writes
 * what the agent does to the feed, and stops when the queue is empty.
 *
 * Only the lease holder drains, so a second wake is a no-op ('busy'). After
 * releasing, it looks again: a message enqueued while it was finishing would
 * otherwise wait for the next wake, because that message's own wake found the
 * lease taken.
 */
export async function drain(threadId: string, base: DrainDeps): Promise<'drained' | 'busy'> {
  const deps = { ...base, owner: `${base.owner}/${(base.newId ?? (() => crypto.randomUUID()))()}` };
  const { store, owner } = deps;
  const now = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? 60_000;

  let drained = false;
  while ((await store.pending(threadId)).length > 0) {
    if (!(await store.acquireLease(threadId, owner, now() + leaseMs, now()))) return drained ? 'drained' : 'busy';
    drained = true;
    try {
      await runSession(threadId, deps);
    } finally {
      await store.releaseLease(threadId, owner);
    }
  }
  return 'drained';
}

/** One agent session: from the first pending message until the queue is empty. */
async function runSession(threadId: string, deps: DrainDeps): Promise<void> {
  const { store, agent, owner } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const leaseMs = deps.leaseMs ?? 60_000;
  const pollMs = deps.pollMs ?? 1000;

  const first = (await store.pending(threadId))[0];
  if (!first) return;
  const session = await agent.open(threadId);

  let running = false;
  let interrupting = false;
  let runId = newId();

  // The event loop and the poll tick both touch the queue; run them one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const deliver = async (message: StoredMessage, priority?: 'next'): Promise<boolean> => {
    if (!(await store.claim(threadId, message.id, now()))) return false;
    await store.append(
      threadId,
      [{ type: 'CUSTOM', name: 'wasp.message', value: { messageId: message.id, text: message.text, deliver: message.deliver } }],
      now()
    );
    session.send({ text: message.text, ...(priority ? { priority } : {}) });
    return true;
  };

  /** Starts the next turn with the first pending message, or ends the session. */
  const startNext = async (): Promise<void> => {
    for (const message of await store.pending(threadId)) {
      if (await deliver(message)) return;
    }
    session.end();
  };

  const tick = () =>
    serial(async () => {
      if (!(await store.renewLease(threadId, owner, now() + leaseMs))) {
        // Another runner took the thread over: stop writing to it.
        await interrupt(session);
        session.end();
        return;
      }
      if (!running) return;
      if (await store.takeInterrupt(threadId)) {
        await interrupt(session);
        return;
      }
      for (const message of await store.pending(threadId)) {
        if (message.deliver === 'now') {
          // It is first in the queue (orderKey): the turn's end delivers it.
          await interrupt(session);
          return;
        }
        if (message.deliver === 'asap') await deliver(message, 'next');
      }
    });

  async function interrupt(s: AgentSession) {
    if (interrupting || !running) return;
    interrupting = true;
    await s.interrupt();
  }

  await serial(async () => {
    if (!(await deliver(first))) await startNext();
  });
  const timer = setInterval(() => void tick().catch(() => undefined), pollMs);
  try {
    for await (const event of session.events) {
      await serial(async () => {
        if (event.type === 'turn_start') {
          running = true;
          runId = newId();
        }
        await store.append(threadId, toFeedEvents(event, { threadId, runId, newId }), now());
        if (event.type === 'turn_end') {
          running = false;
          interrupting = false;
          await startNext();
        }
      });
    }
  } finally {
    clearInterval(timer);
    await chain;
  }
}
