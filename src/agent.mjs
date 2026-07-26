// One agent turn per /invocations call.
//
// AgentCore gives each session its own microVM and routes same-session requests
// back to it, so within a session we can `resume` the prior SDK session id to
// keep the thread. Across microVM restarts (scale-down, new session) you would
// attach a SessionStore adapter to persist transcripts; that's the "hybrid"
// pattern from the hosting doc and is left as a wiring point (see README).

import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Per-session working directory. Defaults suit the container (/work); override
// with AGENT_WORK_DIR when running outside one.
const WORK_BASE = process.env.AGENT_WORK_DIR || '/work';

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
//                the working directory, which is where transcripts live, so it
//                must not change across a conversation's turns.
//   resumeId   — the SDK's own session id from a prior turn, to `resume`. These
//                two ids are distinct: the SDK mints its own id we can't choose,
//                so the caller keeps a stable id and we map it to the SDK id.
// `onEvent` receives {type,...} events for streaming.
// Returns { sdkSessionId, text, toolUses, result }.
export async function runTurn({ prompt, sessionKey, resumeId, config, onEvent }) {
  const { cwd, env } = sessionEnv(sessionKey || 'default');

  let sdkSessionId = resumeId || null;
  let text = '';
  const toolUses = [];
  let result = null;

  const runner = query({
    prompt,
    options: {
      model: config.model,
      systemPrompt: config.systemPrompt,
      maxTurns: config.maxTurns,
      ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
      ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
      // Isolation (hosting doc, "Multi-tenant isolation"): don't inherit the
      // container's dev-facing CLAUDE.md / user settings; give each session its
      // own working dir; never auto-load memory.
      settingSources: [],
      cwd,
      env,
      ...(resumeId ? { resume: resumeId } : {}),
    },
  });

  for await (const m of runner) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (m.session_id) sdkSessionId = m.session_id;
    } else if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text' && b.text.trim()) {
          text += b.text;
          onEvent?.({ type: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          toolUses.push({ name: b.name, input: b.input });
          onEvent?.({ type: 'tool_use', name: b.name, input: b.input });
        }
      }
    } else if (m.type === 'result') {
      result = { subtype: m.subtype, usage: m.usage, total_cost_usd: m.total_cost_usd };
      onEvent?.({ type: 'result', result });
    }
  }

  return { sdkSessionId, text, toolUses, result };
}
