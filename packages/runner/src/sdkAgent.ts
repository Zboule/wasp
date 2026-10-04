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
};

/**
 * Turns run on the Claude Agent SDK, one streaming-input query per session.
 * The thread id is the SDK session id, so any microVM resumes the same
 * transcript from the SessionStore; it must therefore be a UUID.
 */
export function sdkAgent(config: SdkAgentConfig): Agent {
  return {
    async open(threadId) {
      const cwd = path.join(config.workDir, threadId);
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
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        ...(config.sessionStore ? { sessionStore: config.sessionStore } : {}),
        ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
        ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
        ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        ...(config.disallowedTools ? { disallowedTools: config.disallowedTools } : {}),
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
