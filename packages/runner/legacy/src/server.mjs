// AgentCore-compatible HTTP server. Implements the Runtime container contract:
//   - listens on 0.0.0.0:8080
//   - GET  /ping         -> {"status":"Healthy"} | {"status":"HealthyBusy"}
//   - POST /invocations  -> runs one agent turn, streams SSE (JSON fallback)
// Session id arrives in the X-Amzn-Bedrock-AgentCore-Runtime-Session-Id header
// (AgentCore sets it); locally you can pass "sessionId" in the body instead.
//
// The same server runs anywhere a container runs — AgentCore is just one host.

import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { resolveAuth } from './auth.mjs';
import { agentConfig } from './config.mjs';
import { runTurn } from './agent.mjs';
import { loadSecrets } from './secrets.mjs';
import { createPublisher } from './publish.mjs';
import { writeTurnResult } from './sink-dynamo.mjs';

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
const USER_HEADER = 'x-amzn-bedrock-agentcore-runtime-user-id';

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${stamp()}  ${msg}`);

// Pull any secrets (e.g. CLAUDE_CODE_OAUTH_TOKEN) from SSM Parameter Store
// into the env BEFORE resolving auth. No-op if AGENT_SECRET_SSM_PARAM is unset.
const loadedSecrets = await loadSecrets();
if (loadedSecrets.length) log(`secrets: loaded ${loadedSecrets.join(', ')} from SSM`);

// Resolve auth ONCE at boot so a misconfigured container fails fast and loud
// rather than on the first request.
const auth = resolveAuth();
log(`auth: mode=${auth.mode} — ${auth.billing}`);

let inFlight = 0;

// The SDK session id for a conversation, DERIVED rather than remembered.
//
// This used to be an in-memory Map from the caller's stable session id to the
// SDK session id minted on the first turn. That is wrong on AgentCore, and
// quietly so: the microVM is reclaimed once a turn goes idle, so the next
// message arrives with the map empty, the SDK mints a fresh id, and the S3
// SessionStore — keyed by the SDK's id — writes a brand new transcript. Nothing
// errored. The history was saved faithfully, to a key nobody would ever read
// again, and the assistant met every second message as a stranger.
//
// A derived id has no such gap: the same conversation resolves to the same UUID
// on any microVM, for ever, with nothing held anywhere. UUIDv5 over the caller's
// session id (RFC 4122 §4.3, SHA-1, name-based), because `options.sessionId`
// requires a well-formed UUID.
const UUID_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'); // RFC 4122 DNS namespace

function sessionUuidFor(name) {
  const h = createHash('sha1').update(UUID_NAMESPACE).update(name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const server = createServer(async (req, res) => {
  // Health check. HealthyBusy keeps the AgentCore session alive across a turn.
  if (req.method === 'GET' && req.url.split('?')[0] === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: inFlight > 0 ? 'HealthyBusy' : 'Healthy' }));
    return;
  }

  if (req.method === 'POST' && req.url.split('?')[0] === '/invocations') {
    inFlight++;
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || '{}');
    } catch {
      inFlight--;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }

    const prompt = payload.prompt ?? payload.input;
    if (!prompt) {
      inFlight--;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing "prompt"' }));
      return;
    }

    // Stable per-conversation id: AgentCore's header, else a caller-supplied id,
    // else a fresh one we mint and hand back so the client can continue.
    const sessionId = req.headers[SESSION_HEADER] || payload.sessionId || randomUUID();
    // Per-user attribution: AgentCore sets the user-id header from
    // invoke-agent-runtime --runtime-user-id; fall back to the body.
    const userId = req.headers[USER_HEADER] || payload.userId || null;
    const runId = payload.runId || randomUUID();
    // The consumer's logical thread key (book pid), distinct from the AgentCore
    // session id used for affinity/resume.
    const threadId = payload.threadId || sessionId;
    // The sender's short-lived token, used ONLY as the per-turn MCP auth header.
    // Never logged, never persisted, never put in the prompt/transcript.
    const userToken = payload.userToken || null;
    // Keyed on the AgentCore session id, not threadId: it is the id that already
    // keys the working directory, and the store's project key comes from there.
    const threadSessionId = sessionUuidFor(sessionId);
    const config = agentConfig(payload.config || {});
    // Clients that want a single JSON blob instead of the SSE stream ask for it.
    const wantsJson = (req.headers.accept || '').includes('application/json') || /(?:\?|&)format=json/.test(req.url);

    log(`invoke: session=${sessionId.slice(0, 8)} run=${runId.slice(0, 8)} user=${userId || '-'} model=${config.model}`);

    try {
      // Publish mode (Petit Songe): deliver events out-of-band to the consumer's
      // ingest endpoint. The invoker fires-and-forgets; we keep the request open
      // (so AgentCore keeps the microVM busy) and run the turn to completion,
      // publishing each event via the callback. Ack immediately so the caller can
      // drop the connection; the run continues regardless (spike #1).
      const agentTable = process.env.AGENT_TABLE;
      const callbackUrl = process.env.AGENT_EVENT_CALLBACK_URL;
      if (agentTable || callbackUrl) {
        // Ack immediately; the caller drops the connection and the run continues
        // (spike #1). We keep the request open so AgentCore keeps the microVM busy.
        // Ack and CLOSE the response immediately; the invoker can return now.
        // We keep running the turn in the background: inFlight stays > 0, so
        // /ping reports HealthyBusy and AgentCore keeps the microVM alive until
        // the turn finishes (then it goes idle and is reclaimed).
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, threadId, runId }));
        const pub = callbackUrl && !agentTable
          ? createPublisher({ url: callbackUrl, secret: process.env.AGENT_EVENT_CALLBACK_SECRET, threadId, runId, userId, log })
          : null;
        try {
          const out = await runTurn({ prompt, sessionKey: sessionId, threadSessionId, config, userId, runId, userToken, onEvent: pub ? (ev) => pub.emit(ev) : undefined });
          if (agentTable) {
            await writeTurnResult({ table: agentTable, threadId, runId, userId, text: out.text, result: out.result });
            log(`sink: wrote turn result to ${agentTable} (thread=${threadId.slice(0,8)} run=${runId.slice(0,8)})`);
          }
        } catch (e) {
          log(`publish-mode error: ${String(e?.message || e).slice(0,200)}`);
          if (pub) pub.emit({ type: 'error', error: String(e?.message || e) });
        }
        if (pub) await pub.close();
        return;
      }

      if (wantsJson) {
        const out = await runTurn({ prompt, sessionKey: sessionId, threadSessionId, config, userId, runId });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sessionId, runId, userId, text: out.text, toolUses: out.toolUses, result: out.result }));
      } else {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        send({ type: 'session', sessionId });
        const out = await runTurn({ prompt, sessionKey: sessionId, threadSessionId, config, userId, runId, onEvent: send });
        send({ type: 'done', sessionId, runId, userId, result: out.result });
        res.end();
      }
    } catch (e) {
      log(`error: ${String(e?.message || e).slice(0, 300)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    } finally {
      inFlight--;
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', try: ['GET /ping', 'POST /invocations'] }));
});

server.listen(PORT, HOST, () => log(`agent-runtime listening on ${HOST}:${PORT}`));
