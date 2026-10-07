import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { type MappingState, pluginOptions, toAgentEvents } from './sdkAgent.ts';

const sdk = (m: unknown) => m as SDKMessage;
const fresh = (): MappingState => ({ interrupting: false, sessionCostUsd: 0 });
const result = (subtype: string, totalCostUsd: number) =>
  sdk({ type: 'result', subtype, is_error: subtype !== 'success', num_turns: 2, duration_ms: 900, total_cost_usd: totalCostUsd });

describe('toAgentEvents', () => {
  it('announces each turn on `init`, and ignores other system messages', () => {
    expect(toAgentEvents(sdk({ type: 'system', subtype: 'init' }), fresh())).toEqual([{ type: 'turn_start' }]);
    expect(toAgentEvents(sdk({ type: 'system', subtype: 'thinking_tokens' }), fresh())).toEqual([]);
  });

  it('keeps text and tool calls in order, without thinking or blank text', () => {
    const message = sdk({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hm' },
          { type: 'text', text: 'Checking.' },
          { type: 'text', text: '  ' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }
        ]
      }
    });
    expect(toAgentEvents(message, fresh())).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } }
    ]);
  });

  it('flattens tool results to text, marking errors and non-text parts', () => {
    const message = sdk({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'plain' },
          { type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'boom' }, { type: 'image' }] }
        ]
      }
    });
    expect(toAgentEvents(message, fresh())).toEqual([
      { type: 'tool_result', toolCallId: 't1', output: 'plain', isError: false },
      { type: 'tool_result', toolCallId: 't2', output: 'boom[image]', isError: true }
    ]);
  });

  it("reports each turn's own cost, though the SDK's is cumulative", () => {
    const state = fresh();
    expect(toAgentEvents(result('success', 0.02), state)).toMatchObject([{ type: 'turn_end', outcome: 'done', costUsd: 0.02 }]);
    const second = toAgentEvents(result('success', 0.05), state)[0];
    expect(second?.type === 'turn_end' && second.costUsd).toBeCloseTo(0.03);
  });

  it('tells an interrupt apart from a failure', () => {
    expect(toAgentEvents(result('error_during_execution', 0.01), { interrupting: true, sessionCostUsd: 0 })[0]).toMatchObject({
      outcome: 'interrupted'
    });
    expect(toAgentEvents(result('error_max_turns', 0.01), fresh())[0]).toMatchObject({ outcome: 'failed', error: 'error_max_turns' });
  });
});

describe('cliEnv', () => {
  it('gives the CLI the Claude credential we pass, and no AWS or competing credentials', async () => {
    const { cliEnv } = await import('./sdkAgent.ts');
    const env = cliEnv(
      {
        PATH: '/usr/bin',
        AWS_ACCESS_KEY_ID: 'AKIA',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_SESSION_TOKEN: 'session',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
        ANTHROPIC_API_KEY: 'stale-key',
        CLAUDE_CODE_USE_BEDROCK: '1'
      },
      { CLAUDE_CODE_OAUTH_TOKEN: 'oat' }
    );
    expect(env).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });
});

describe('pluginOptions', () => {
  it("loads the definition's skills as a local plugin, every one enabled", () => {
    expect(pluginOptions('/app/definition')).toEqual({ plugins: [{ type: 'local', path: '/app/definition' }], skills: 'all' });
  });

  it('adds nothing when the definition has no skills', () => {
    expect(pluginOptions(undefined)).toEqual({});
  });
});
