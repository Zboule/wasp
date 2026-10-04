// Per-service agent config. This is what makes the image reusable: the same
// container runs TopTopTime's agent or petitsonge's agent, differing only by
// this config (system prompt, model, tools, MCP servers).
//
// Config resolves from, in order of increasing precedence:
//   1. defaults below
//   2. a JSON file at AGENT_CONFIG_FILE (baked into the image or mounted)
//   3. individual env vars (handy overrides)
//   4. per-request `config` field in the /invocations body (dev convenience)

import { readFileSync } from 'node:fs';

const DEFAULTS = {
  model: 'claude-sonnet-5',
  systemPrompt: 'You are a helpful assistant.',
  // Empty = inherit the SDK's default tool set. Narrow this per service.
  allowedTools: undefined,
  // MCP servers this agent may call, in the SDK's mcpServers shape.
  mcpServers: undefined,
  // Bound each turn so a runaway agent can't loop forever (there is no built-in
  // wall-clock session timeout — see the hosting doc's "known limitations").
  maxTurns: 24,
  // Spend guard: the SDK stops with error_max_budget_usd past this.
  maxBudgetUsd: 2.0,
};

function fromFile() {
  const p = process.env.AGENT_CONFIG_FILE;
  if (!p) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`AGENT_CONFIG_FILE=${p} could not be read: ${e.message}`);
  }
}

function fromEnv() {
  const out = {};
  if (process.env.AGENT_MODEL) out.model = process.env.AGENT_MODEL;
  if (process.env.AGENT_SYSTEM_PROMPT) out.systemPrompt = process.env.AGENT_SYSTEM_PROMPT;
  if (process.env.AGENT_MAX_TURNS) out.maxTurns = Number(process.env.AGENT_MAX_TURNS);
  if (process.env.AGENT_MAX_BUDGET_USD) out.maxBudgetUsd = Number(process.env.AGENT_MAX_BUDGET_USD);
  if (process.env.AGENT_ALLOWED_TOOLS) out.allowedTools = process.env.AGENT_ALLOWED_TOOLS.split(',').map((s) => s.trim());
  return out;
}

const base = { ...DEFAULTS, ...fromFile(), ...fromEnv() };

export function agentConfig(overrides = {}) {
  return { ...base, ...overrides };
}

export function baseConfig() {
  return base;
}
