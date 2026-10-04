import type { McpServerSpec } from './mcpProxy.ts';

/**
 * What an agent is, beyond its prompt: `definition/wasp.config.json`, overridden
 * by WaspAgent's args (passed as environment variables). Validated strictly:
 * it decides what the agent can reach.
 */
export type AgentConfig = {
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Restricts the built-in and MCP tools the agent has. */
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerSpec>;
};

const DEFAULTS = { model: 'claude-sonnet-5-5', maxTurns: 40, maxBudgetUsd: 5 };
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function loadConfig(env: NodeJS.ProcessEnv, readFile: (path: string) => string): AgentConfig {
  const file = env.WASP_CONFIG_FILE ? parse(JSON.parse(readFile(env.WASP_CONFIG_FILE)), 'wasp.config.json') : {};
  const fromEnv = parse(
    {
      ...(env.WASP_MODEL ? { model: env.WASP_MODEL } : {}),
      ...(env.WASP_MAX_TURNS ? { maxTurns: Number(env.WASP_MAX_TURNS) } : {}),
      ...(env.WASP_MAX_BUDGET_USD ? { maxBudgetUsd: Number(env.WASP_MAX_BUDGET_USD) } : {}),
      ...(env.WASP_TOOLS ? { tools: JSON.parse(env.WASP_TOOLS) } : {}),
      ...(env.WASP_DISALLOWED_TOOLS ? { disallowedTools: JSON.parse(env.WASP_DISALLOWED_TOOLS) } : {}),
      ...(env.WASP_MCP_SERVERS ? { mcpServers: JSON.parse(env.WASP_MCP_SERVERS) } : {})
    },
    'WaspAgent args'
  );
  return { ...DEFAULTS, ...file, ...fromEnv };
}

function parse(raw: unknown, source: string): Partial<AgentConfig> {
  const fail = (what: string): never => {
    throw new Error(`wasp: ${source}: ${what}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must be an object');
  const r = raw as Record<string, unknown>;
  const known = ['model', 'maxTurns', 'maxBudgetUsd', 'tools', 'disallowedTools', 'mcpServers'];
  for (const key of Object.keys(r)) if (!known.includes(key)) fail(`unknown key "${key}"`);
  const out: Partial<AgentConfig> = {};
  if (r.model !== undefined) out.model = typeof r.model === 'string' && r.model ? r.model : fail('model must be a string');
  if (r.maxTurns !== undefined)
    out.maxTurns = Number.isInteger(r.maxTurns) && (r.maxTurns as number) > 0 ? (r.maxTurns as number) : fail('maxTurns must be a positive integer');
  if (r.maxBudgetUsd !== undefined)
    out.maxBudgetUsd = typeof r.maxBudgetUsd === 'number' && r.maxBudgetUsd > 0 ? r.maxBudgetUsd : fail('maxBudgetUsd must be a positive number');
  for (const key of ['tools', 'disallowedTools'] as const) {
    if (r[key] === undefined) continue;
    const list = r[key];
    out[key] = Array.isArray(list) && list.every((t) => typeof t === 'string' && t) ? (list as string[]) : fail(`${key} must be a list of tool names`);
  }
  if (r.mcpServers !== undefined) {
    const servers = r.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) fail('mcpServers must be an object');
    out.mcpServers = {};
    for (const [name, spec] of Object.entries(servers as Record<string, unknown>)) {
      if (!NAME.test(name)) fail(`MCP server name "${name}" must be letters, digits, - or _`);
      const s = spec as Record<string, unknown>;
      if (!s || typeof s !== 'object') fail(`MCP server "${name}" must be an object`);
      for (const key of Object.keys(s)) if (key !== 'url' && key !== 'auth') fail(`MCP server "${name}": unknown key "${key}"`);
      let url: URL | undefined;
      try {
        url = new URL(String(s.url));
      } catch {
        fail(`MCP server "${name}" needs a valid url`);
      }
      // A caller token only ever travels encrypted on the wire.
      if (url!.protocol !== 'https:' && !(s.auth !== 'caller' && url!.protocol === 'http:')) fail(`MCP server "${name}" must use https`);
      if (s.auth !== undefined && s.auth !== 'caller' && s.auth !== 'none') fail(`MCP server "${name}": auth is "caller" or "none"`);
      out.mcpServers[name] = { url: url!.href, auth: (s.auth as 'caller' | 'none' | undefined) ?? 'none' };
    }
  }
  return out;
}
