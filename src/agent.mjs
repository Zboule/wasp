// One agent turn per /invocations call.
//
// AgentCore gives each session its own microVM and routes same-session requests
// back to it, but it does NOT keep that microVM: once a turn goes idle the VM is
// reclaimed, and the next message on the same conversation lands on a fresh one.
// So the thread cannot be held in the process. It is held in the SessionStore,
// under an id the caller CHOOSES: `options.sessionId` pins the SDK's session id
// to a deterministic value derived from the conversation, so the transcript is
// written and read back at the same key for ever. That is the "hybrid" pattern
// from the hosting doc, and the pinned id is the half that makes it work.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createS3SessionStore } from './session-store.mjs';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Per-session working directory. Defaults suit the container (/work); override
// with AGENT_WORK_DIR when running outside one.
const WORK_BASE = process.env.AGENT_WORK_DIR || '/work';

const logLine = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

// Optional S3 SessionStore so a thread's model context survives microVM
// recycling. Created once if a bucket is configured.
const sessionStore = process.env.AGENT_SESSIONSTORE_S3_BUCKET
  ? createS3SessionStore({
      bucket: process.env.AGENT_SESSIONSTORE_S3_BUCKET,
      prefix: process.env.AGENT_SESSIONSTORE_S3_PREFIX || 'sessions',
      region: process.env.AWS_REGION || 'eu-west-1',
      log: logLine,
    })
  : undefined;

// Per-session CONFIG-dir isolation is only needed when many tenants share ONE
// container. Under AgentCore each session already gets its own microVM, so it's
// redundant there — and setting a custom CLAUDE_CONFIG_DIR makes the CLI look
// for file-based creds in it, bypassing the macOS keychain and breaking the
// saved-`claude login` path. So it's OPT-IN via AGENT_ISOLATE_CONFIG_DIR=1.
const ISOLATE_CONFIG = process.env.AGENT_ISOLATE_CONFIG_DIR === '1';
const CONFIG_BASE = process.env.AGENT_CONFIG_BASE || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');

function sessionEnv(sessionKey) {
  const cwd = path.join(WORK_BASE, sessionKey);
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  if (ISOLATE_CONFIG) {
    const configDir = path.join(CONFIG_BASE, sessionKey);
    mkdirSync(configDir, { recursive: true });
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return { cwd, env };
}

// Runs a single turn.
//   sessionKey — STABLE per-conversation id (AgentCore's session header). Keys
//                the working directory, and the SDK derives the store's project
//                key from that directory, so it must not change across a
//                conversation's turns or the transcript moves out from under it.
//   threadId   — the SDK session id to pin, deterministic per conversation. The
//                caller derives it (see server.mjs); we resume it if it exists
//                and create it under that exact id if it does not.
// `onEvent` receives {type,...} events for streaming.
// Returns { sdkSessionId, text, toolUses, result }.
export async function runTurn({ prompt, sessionKey, threadSessionId, config, userId, runId, userToken, onEvent }) {
  const { cwd, env } = sessionEnv(sessionKey || 'default');

  // Per-turn MCP: install the consumer's API as an http MCP server, carrying THIS
  // turn's user token, so tool calls act as the sender of the current message.
  //
  // The server's NAME is per-service, because it becomes the prefix the model
  // sees on every tool (`mcp__<name>__get_tree`). It was hardcoded to
  // `petitsonge`, which is right for one consumer and wrong for a reusable
  // engine: the second service would show its own tools under another
  // product's name. AGENT_MCP_NAME sets it. Petit Songe pins its image by
  // digest, so this cannot move under it, but it must set
  // AGENT_MCP_NAME=petitsonge if it ever rebuilds from this commit.
  const mcpUrl = process.env.AGENT_MCP_HTTP_URL;
  const mcpName = (process.env.AGENT_MCP_NAME || 'api').replace(/[^A-Za-z0-9_]/g, '') || 'api';
  const mcpServers = mcpUrl && userToken
    ? { [mcpName]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${userToken}` } } }
    : config.mcpServers;
  // `allowedTools` REPLACES the SDK's default set rather than adding to it, so a
  // service that wants the file and shell tools has to name them in its own
  // config: appending only the MCP entry would silently take Read, Write and
  // Bash away from an agent that had them by default.
  const allowedTools = mcpUrl && userToken
    ? [...(config.allowedTools || []), `mcp__${mcpName}`]
    : config.allowedTools;

  const baseOptions = {
    model: config.model,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
    ...(sessionStore ? { sessionStore } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(mcpUrl && userToken ? { permissionMode: 'bypassPermissions' } : {}),
    // Isolation (hosting doc, "Multi-tenant isolation"): don't inherit the
    // container's dev-facing CLAUDE.md / user settings; give each session its
    // own working dir; never auto-load memory.
    settingSources: [],
    cwd,
    env,
  };

  // One pass over the SDK stream. Separated out because a first turn has to run
  // it twice: see the fallback below.
  async function once(sessionOption) {
    let sawInit = false;
    let sdkSessionId = threadSessionId || null;
    let text = '';
    const toolUses = [];
    let result = null;

    // Events are held until `init`, then streamed live.
    //
    // A pass that never reaches init is a pass we may silently retry, and it is
    // not silent if the caller has already been told about it: a failed resume
    // emits a `result` of subtype `error_during_execution` on its way out, which
    // down the socket reads as the turn having failed. Holding until init means
    // an abandoned attempt says nothing at all. Nothing is lost in the normal
    // case, where init is the first message to arrive.
    let held = [];
    const emit = (ev) => {
      if (!onEvent) return;
      if (sawInit) onEvent(ev);
      else held.push(ev);
    };
    const release = () => {
      const pending = held;
      held = [];
      for (const ev of pending) onEvent?.(ev);
    };

    try {
      for await (const m of query({ prompt, options: { ...baseOptions, ...sessionOption } })) {
        if (m.type === 'system' && m.subtype === 'init') {
          sawInit = true;
          if (m.session_id) sdkSessionId = m.session_id;
          release();
        } else if (m.type === 'assistant') {
          for (const b of m.message.content) {
            if (b.type === 'text' && b.text.trim()) {
              text += b.text;
              emit({ type: 'text', text: b.text });
            } else if (b.type === 'tool_use') {
              toolUses.push({ name: b.name, input: b.input });
              emit({ type: 'tool_use', name: b.name, input: b.input });
            }
          }
        } else if (m.type === 'result') {
          result = { subtype: m.subtype, usage: m.usage, total_cost_usd: m.total_cost_usd, userId, runId };
          emit({ type: 'result', result });
        }
      }
    } catch (e) {
      return { failed: e, sawInit, release, sdkSessionId, text, toolUses, result };
    }
    return { failed: null, sawInit, release, sdkSessionId, text, toolUses, result };
  }

  // A pass whose failure we are NOT going to retry: let go of anything it held
  // back before raising, so the caller hears what the SDK actually said.
  const giveUp = (out) => {
    out.release();
    throw out.failed;
  };

  // No pinned id: nothing to resume, nothing to keep. Single pass.
  if (!threadSessionId) {
    const out = await once({});
    if (out.failed) giveUp(out);
    return out;
  }

  // Resume first, always. We cannot know from here whether this conversation has
  // a transcript: the store is keyed by the SDK's own project key, derived from
  // `cwd` in a form we would have to guess at, and guessing wrong would silently
  // start every turn from nothing — which is the bug this replaces.
  //
  // So we ask by trying. Resuming a session that does not exist fails BEFORE the
  // `init` message, which is what makes the retry safe: no init means the session
  // never started, so no model call was made and no tool ever ran. Retrying can
  // therefore not repeat a side effect, and a first turn simply costs one extra
  // spawn that fails in about a second. If init HAS been seen, the failure came
  // from the turn itself and is the caller's to hear about.
  const resumed = await once({ resume: threadSessionId });
  if (!resumed.failed) {
    logLine(`session: resumed ${threadSessionId.slice(0, 8)}`);
    return resumed;
  }
  if (resumed.sawInit) giveUp(resumed);

  logLine(`session: nothing to resume at ${threadSessionId.slice(0, 8)}, starting it`);
  const fresh = await once({ sessionId: threadSessionId });
  if (fresh.failed) giveUp(fresh);
  return fresh;
}
