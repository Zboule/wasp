import { UUID } from '@zboule/wasp-protocol';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';

import type { Agent } from './agent.ts';
import { drain } from './drain.ts';
import type { ThreadFiles } from './files.ts';
import type { ThreadStore } from '@zboule/wasp-store';

/** Thread-scoped temporary AWS credentials, minted by the waker outside the microVM. */
export type ThreadCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string };

/** The Claude credential the CLI needs. Exactly one of the two. */
export type ClaudeCredential = { CLAUDE_CODE_OAUTH_TOKEN: string } | { ANTHROPIC_API_KEY: string };

export type Invocation =
  | { op: 'drain'; threadId: string; credentials: ThreadCredentials; claude: ClaudeCredential }
  | { op: 'refresh'; threadId: string; credentials: ThreadCredentials };

/** What one drain needs, built from the credentials the waker handed in. Never from the microVM's own role. */
export type ThreadRuntime = {
  store: ThreadStore;
  agent: Agent;
  offload?: (threadId: string, content: string) => Promise<string>;
  files?: ThreadFiles;
};

/** Ask for fresh credentials this long before the current ones expire (they last at most an hour). */
const REFRESH_BEFORE_MS = 10 * 60_000;

export type RunnerServerDeps = {
  /** Builds the store and agent for one thread. `credentials()` always returns the latest refreshed set. */
  forThread(threadId: string, credentials: () => ThreadCredentials, claude: ClaudeCredential): ThreadRuntime;
  owner: string;
  pollMs?: number;
  log?: (message: string) => void;
};

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

/**
 * The AgentCore Runtime container contract:
 *   GET  /ping         Healthy, or HealthyBusy while a thread is draining (keeps the microVM alive)
 *   POST /invocations  { op: 'drain' | 'refresh', … } from the waker; answered at once, drained in the background
 *
 * One microVM serves one thread (CLAUDE.md, invariant 1): the session header
 * must be the thread id, and a microVM that has drained one thread refuses any other.
 */
export function createRunnerServer(deps: RunnerServerDeps) {
  const log = deps.log ?? ((message: string) => console.log(`${new Date().toISOString()} ${message}`));
  let boundThread: string | null = null;
  let credentials: ThreadCredentials | null = null;
  let draining: Promise<unknown> | null = null;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  async function readInvocation(req: IncomingMessage): Promise<Invocation | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Invocation;
      return body && (body.op === 'drain' || body.op === 'refresh') && typeof body.threadId === 'string' && body.credentials ? body : null;
    } catch {
      return null;
    }
  }

  async function invoke(req: IncomingMessage, res: ServerResponse) {
    const invocation = await readInvocation(req);
    if (!invocation) return json(res, 400, { error: 'expected { op, threadId, credentials }' });
    const { threadId } = invocation;
    if (!UUID.test(threadId) || req.headers[SESSION_HEADER] !== threadId) {
      return json(res, 400, { error: 'the session id must be the thread id' });
    }
    if (boundThread && boundThread !== threadId) return json(res, 409, { error: 'this microVM serves another thread' });
    boundThread = threadId;
    credentials = invocation.credentials;

    if (invocation.op === 'refresh') return json(res, 200, { refreshed: true });
    if (!draining) {
      const runtime = deps.forThread(threadId, () => credentials!, invocation.claude);
      let requestedFor: string | null = null;
      const onTick = async () => {
        const expiry = credentials!.expiration;
        if (requestedFor === expiry || Date.parse(expiry) - Date.now() > REFRESH_BEFORE_MS) return;
        requestedFor = expiry;
        await runtime.store.requestCredentials(threadId, Date.now());
      };
      draining = drain(threadId, { ...runtime, owner: deps.owner, onTick, ...(deps.pollMs ? { pollMs: deps.pollMs } : {}) })
        .then((outcome) => log(`drain ${threadId}: ${outcome}`))
        .catch((error: unknown) => log(`drain ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => (draining = null));
    }
    json(res, 202, { accepted: true });
  }

  return createServer((req, res) => {
    const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    if (route === 'GET /ping') return json(res, 200, { status: draining ? 'HealthyBusy' : 'Healthy' });
    if (route !== 'POST /invocations') return json(res, 404, { error: 'not found' });
    invoke(req, res).catch((error: unknown) => {
      log(`invocation error: ${String(error)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });
}
