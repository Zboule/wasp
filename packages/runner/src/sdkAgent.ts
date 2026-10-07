import {
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
  getSessionInfo,
  query
} from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { Agent, AgentEvent, AgentSession } from './agent.ts';

export type SdkAgentConfig = {
  model: string;
  /** Appended to the Claude Code preset. */
  systemPrompt?: string;
  workDir: string;
  sessionStore?: SessionStore;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: Record<string, McpServerConfig>;
  /** Restricts the available tools (the SDK's `tools`); `allowedTools` would only auto-approve. */
  tools?: string[];
  disallowedTools?: string[];
  /** The Claude credential, given to the CLI only (never put in this process's environment). */
  claude?: { CLAUDE_CODE_OAUTH_TOKEN: string } | { ANTHROPIC_API_KEY: string };
  /** The plugin the image builds from the definition's `skills/` (see `pluginOptions`). */
  pluginDir?: string;
};

/**
 * The definition's skills, as a local plugin: filesystem settings stay off
 * (`settingSources: []`), so this is how the app's skills reach the agent, next
 * to Claude Code's bundled ones. They are listed to the model as `agent:<name>`,
 * and every one is enabled. A `tools` allowlist must include `Skill`.
 */
export function pluginOptions(pluginDir: string | undefined): Pick<Options, 'plugins' | 'skills'> {
  return pluginDir ? { plugins: [{ type: 'local', path: pluginDir }], skills: 'all' } : {};
}

/**
 * Variables that would make the CLI use another credential than the one we
 * pass (cloud providers, then ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY,
 * then CLAUDE_CODE_OAUTH_TOKEN), plus AWS credentials, which the agent must
 * never see (CLAUDE.md, invariant 2).
 */
const STRIPPED_FROM_CLI_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'
];

export function cliEnv(base: NodeJS.ProcessEnv, claude: SdkAgentConfig['claude']): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_FROM_CLI_ENV.includes(key)) env[key] = value;
  }
  return { ...env, ...(claude ?? {}), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}

/** The agent's cwd for a thread. Uploaded files land under its `files/` folder. */
export function threadWorkDir(workDir: string, threadId: string): string {
  return path.join(workDir, threadId);
}

/**
 * Turns run on the Claude Agent SDK, one streaming-input query per session.
 * The thread id is the SDK session id, so any microVM resumes the same
 * transcript from the SessionStore; it must therefore be a UUID.
 */
export function sdkAgent(config: SdkAgentConfig): Agent {
  return {
    async open(threadId) {
      const cwd = threadWorkDir(config.workDir, threadId);
      mkdirSync(cwd, { recursive: true });
      const existing = await getSessionInfo(threadId, { dir: cwd, sessionStore: config.sessionStore });
      const input = channel<SDKUserMessage>();
      const options: Options = {
        model: config.model,
        cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(config.systemPrompt ? { append: config.systemPrompt } : {}) },
        // The microVM is the sandbox.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        env: config.claude ? cliEnv(process.env, config.claude) : { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        ...(config.sessionStore ? { sessionStore: config.sessionStore } : {}),
        ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
        ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
        ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.disallowedTools ? { disallowedTools: config.disallowedTools } : {}),
        ...pluginOptions(config.pluginDir),
        ...(existing ? { resume: threadId } : { sessionId: threadId })
      };
      const q = query({ prompt: input, options });
      const state: MappingState = { interrupting: false, sessionCostUsd: 0 };

      const debug = process.env.WASP_DEBUG ? (m: SDKMessage) => console.error('[sdk]', describe(m)) : undefined;
      async function* events(): AsyncGenerator<AgentEvent> {
        try {
          for await (const message of q) {
            debug?.(message);
            yield* toAgentEvents(message, state);
            if (message.type === 'result') state.interrupting = false;
          }
        } catch (error) {
          // The SDK throws on some error results instead of yielding them. The
          // session is unusable after that: end the turn as failed, and the
          // drain loop opens a fresh session (same transcript) for what is queued.
          yield { type: 'turn_end', outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
        }
      }

      const session: AgentSession = {
        send({ text, priority }) {
          input.push({
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            ...(priority ? { priority } : {})
          });
        },
        async interrupt() {
          state.interrupting = true;
          await q.interrupt();
        },
        end() {
          input.close();
        },
        events: events()
      };
      return session;
    }
  };
}

export type MappingState = {
  interrupting: boolean;
  /** The SDK reports cost cumulatively over the session; turns report their own share. */
  sessionCostUsd: number;
};

/** What the drain loop needs from one SDK message. Thinking, system notices and stream deltas are dropped. */
export function toAgentEvents(message: SDKMessage, state: MappingState): AgentEvent[] {
  switch (message.type) {
    case 'system':
      // The SDK announces every turn of a streaming session with `init`.
      return message.subtype === 'init' ? [{ type: 'turn_start' }] : [];
    case 'assistant':
      return message.message.content.flatMap((block): AgentEvent[] => {
        if (block.type === 'text' && block.text.trim()) return [{ type: 'text', text: block.text }];
        if (block.type === 'tool_use') return [{ type: 'tool_call', id: block.id, name: block.name, input: block.input }];
        return [];
      });
    case 'user': {
      const content = message.message.content;
      if (typeof content === 'string') return [];
      return content.flatMap((block): AgentEvent[] =>
        block.type === 'tool_result'
          ? [{ type: 'tool_result', toolCallId: block.tool_use_id, output: textOf(block.content), isError: block.is_error === true }]
          : []
      );
    }
    case 'result': {
      const costUsd = Math.max(0, message.total_cost_usd - state.sessionCostUsd);
      state.sessionCostUsd = message.total_cost_usd;
      return [
        {
          type: 'turn_end',
          outcome: state.interrupting ? 'interrupted' : message.subtype === 'success' ? 'done' : 'failed',
          ...(message.subtype !== 'success' && !state.interrupting ? { error: message.subtype } : {}),
          costUsd,
          numTurns: message.num_turns,
          durationMs: message.duration_ms
        }
      ];
    }
    default:
      return [];
  }
}

function describe(m: SDKMessage): string {
  if (m.type === 'result') return `result ${m.subtype}`;
  if (m.type === 'system') return `system ${m.subtype}`;
  if (m.type === 'assistant') return `assistant ${m.message.content.map((b) => b.type).join(',')}`;
  if (m.type === 'user') return `user ${typeof m.message.content === 'string' ? 'text' : m.message.content.map((b) => b.type).join(',')}`;
  return m.type;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`)).join('');
}

function channel<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(item: T) {
      items.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    }
  };
}
