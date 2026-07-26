// AgentCore-compatible HTTP server. Implements the Runtime container contract:
//   - listens on 0.0.0.0:8080
//   - GET  /ping         -> {"status":"Healthy"} | {"status":"HealthyBusy"}
//   - POST /invocations  -> runs one agent turn, streams SSE (JSON fallback)
// Session id arrives in the X-Amzn-Bedrock-AgentCore-Runtime-Session-Id header
// (AgentCore sets it); locally you can pass "sessionId" in the body instead.
//
// The same server runs anywhere a container runs — AgentCore is just one host.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolveAuth } from './auth.mjs';
import { agentConfig } from './config.mjs';
import { runTurn } from './agent.mjs';
import { loadSecrets } from './secrets.mjs';

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

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

// Stable caller session id -> the SDK's own session id, so follow-up turns can
// `resume` the thread. In-memory is correct for the AgentCore model (one
// microVM per session). To survive a microVM restart, back this with a
// SessionStore adapter (S3/Redis/Postgres) — see README, "Persistence".
const sdkSessionFor = new Map();

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
    const resumeId = sdkSessionFor.get(sessionId) || null;
    const config = agentConfig(payload.config || {});
    // Clients that want a single JSON blob instead of the SSE stream ask for it.
    const wantsJson = (req.headers.accept || '').includes('application/json') || /(?:\?|&)format=json/.test(req.url);

    log(`invoke: session=${sessionId.slice(0, 8)} ${resumeId ? 'resume' : 'new'} model=${config.model} ${wantsJson ? '[json]' : '[sse]'}`);

    try {
      if (wantsJson) {
        const out = await runTurn({ prompt, sessionKey: sessionId, resumeId, config });
        if (out.sdkSessionId) sdkSessionFor.set(sessionId, out.sdkSessionId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sessionId, text: out.text, toolUses: out.toolUses, result: out.result }));
      } else {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        send({ type: 'session', sessionId });
        const out = await runTurn({ prompt, sessionKey: sessionId, resumeId, config, onEvent: send });
        if (out.sdkSessionId) sdkSessionFor.set(sessionId, out.sdkSessionId);
        send({ type: 'done', sessionId, result: out.result });
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
