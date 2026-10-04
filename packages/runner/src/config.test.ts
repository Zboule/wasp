import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.ts';

const files = (content: unknown) => () => JSON.stringify(content);

describe('agent config', () => {
  it('reads the definition file, lets WaspAgent args override it, and falls back to defaults', () => {
    const config = loadConfig(
      {
        WASP_CONFIG_FILE: '/app/definition/wasp.config.json',
        WASP_MAX_TURNS: '12',
        WASP_MCP_SERVERS: JSON.stringify({ app: { url: 'https://mcp.example.com/private', auth: 'caller' } })
      },
      files({ model: 'claude-opus-5-5', maxTurns: 80, disallowedTools: ['Bash'], mcpServers: { other: { url: 'https://x.example.com' } } })
    );
    expect(config).toEqual({
      model: 'claude-opus-5-5',
      maxTurns: 12,
      maxBudgetUsd: 5,
      disallowedTools: ['Bash'],
      mcpServers: { app: { url: 'https://mcp.example.com/private', auth: 'caller' } }
    });
    expect(loadConfig({}, files({}))).toEqual({ model: 'claude-sonnet-5-5', maxTurns: 40, maxBudgetUsd: 5 });
  });

  it('refuses what it does not understand, and a caller token over plain http', () => {
    const load = (content: unknown) => () => loadConfig({ WASP_CONFIG_FILE: 'f' }, files(content));
    expect(load({ modle: 'x' })).toThrow(/unknown key "modle"/);
    expect(load({ maxTurns: 0 })).toThrow(/maxTurns/);
    expect(load({ tools: 'Bash' })).toThrow(/tools/);
    expect(load({ mcpServers: { app: { url: 'http://mcp.example.com', auth: 'caller' } } })).toThrow(/https/);
    expect(load({ mcpServers: { app: { url: 'https://mcp.example.com', auth: 'admin' } } })).toThrow(/auth/);
    expect(load({ mcpServers: { 'a b': { url: 'https://mcp.example.com' } } })).toThrow(/name/);
    expect(load({ mcpServers: { app: { url: 'https://mcp.example.com', headers: {} } } })).toThrow(/unknown key "headers"/);
    expect(loadConfig({ WASP_CONFIG_FILE: 'f' }, files({ mcpServers: { local: { url: 'http://docs.internal/mcp' } } })).mcpServers).toEqual({
      local: { url: 'http://docs.internal/mcp', auth: 'none' }
    });
  });
});
