import type { FeedEvent } from '@zboule/wasp-protocol';

import type { Agent, AgentSession } from './agent.ts';
import { toFeedEvents } from './feed.ts';
import type { ThreadFiles } from './files.ts';
import { messageForAgent } from './message.ts';
import type { StoredMessage, ThreadStore } from '@zboule/wasp-store';

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
  /** Stores a payload too large for the feed and returns its reference. Without it, payloads are truncated. */
  offload?: (threadId: string, content: string) => Promise<string>;
  /** Runs on every tick of a session, e.g. to ask for fresh credentials before they expire. */
  onTick?: () => Promise<void>;
  /** Puts the thread's uploaded files in the agent's working directory. Without it, attachments are only listed. */
  files?: ThreadFiles;
  /**
   * Called with each message just before it is delivered, while it still holds
   * its caller token (the claim deletes it): makes that token the credential of
   * the MCP calls that follow, or clears it when the message has none. A token
   * that cannot be used fails the message instead of delivering it.
   */
  useCaller?: (message: StoredMessage) => Promise<CallerResult>;
};

export type CallerResult = { ok: true } | { ok: false; reason: 'token_expired' | 'invalid' };

/** Feed items stay well under DynamoDB's 400 KB item limit. */
export const INLINE_LIMIT = 64 * 1024;
const PREVIEW_LENGTH = 2_000;

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
  // An interrupt asked for while nothing ran must not kill this session's first turn.
  await store.takeInterrupt(threadId);
  const [session] = await Promise.all([agent.open(threadId), deps.files?.restoreAll()]);

  let running = false;
  let interrupting = false;
  let runId = newId();
  /** The principal of the message that started the running turn: the turn acts as no one else. */
  let turnPrincipal: string | undefined;

  // The event loop and the poll tick both touch the queue; run them one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const deliver = async (message: StoredMessage, priority?: 'next'): Promise<boolean> => {
    // Before the claim: once claimed, the message is the agent's, and its files must already be there.
    if (message.attachments?.length) await deps.files?.fetch(message.attachments);
    const caller = (await deps.useCaller?.(message)) ?? { ok: true };
    if (!(await store.claim(threadId, message.id, now()))) return false;
    if (!caller.ok) {
      // Claimed so it leaves the queue (and its token is deleted), but never shown to the agent.
      await store.append(threadId, [{ type: 'CUSTOM', name: 'wasp.message_failed', value: { messageId: message.id, reason: caller.reason } }], now());
      return false;
    }
    if (!priority) turnPrincipal = message.principal;
    const { id: messageId, text, deliver: mode, attachments } = message;
    await store.append(
      threadId,
      [{ type: 'CUSTOM', name: 'wasp.message', value: { messageId, text, deliver: mode, ...(attachments ? { attachments } : {}) } }],
      now()
    );
    session.send({ text: messageForAgent(text, attachments), ...(priority ? { priority } : {}) });
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
      await deps.onTick?.();
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
        // Another principal's message waits for the next turn instead of joining this one.
        if (message.deliver === 'asap' && message.principal === turnPrincipal) await deliver(message, 'next');
      }
    });

  /** Moves an oversized tool result or argument payload out of the feed. */
  async function fitInline(event: FeedEvent): Promise<FeedEvent> {
    if (event.type !== 'TOOL_CALL_RESULT' && event.type !== 'TOOL_CALL_ARGS') return event;
    const payload = event.type === 'TOOL_CALL_RESULT' ? event.content : event.delta;
    if (payload.length <= INLINE_LIMIT) return event;
    const preview = `${payload.slice(0, PREVIEW_LENGTH)}… [${payload.length} characters]`;
    const ref = deps.offload ? await deps.offload(threadId, payload) : undefined;
    if (event.type === 'TOOL_CALL_RESULT') return { ...event, content: preview, ...(ref ? { outputRef: ref } : {}) };
    return { ...event, delta: preview, ...(ref ? { argsRef: ref } : {}) };
  }

  async function interrupt(s: AgentSession) {
    if (interrupting || !running) return;
    interrupting = true;
    await s.interrupt();
  }

  try {
    await serial(async () => {
      if (!(await deliver(first))) await startNext();
    });
  } catch (error) {
    // Nothing was sent: close the session, or its query stays open.
    session.end();
    throw error;
  }
  const timer = setInterval(() => void tick().catch(() => undefined), pollMs);
  try {
    for await (const event of session.events) {
      await serial(async () => {
        if (event.type === 'turn_start') {
          running = true;
          runId = newId();
        }
        await store.append(threadId, await Promise.all(toFeedEvents(event, { threadId, runId, newId }).map(fitInline)), now());
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
