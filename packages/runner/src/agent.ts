/**
 * The seam between the drain loop and whatever runs turns: the Claude Agent SDK
 * in production (sdkAgent.ts), a scripted fake in tests.
 *
 * A session is one long-lived conversation with streaming input. Sending while a
 * turn runs follows the SDK's priorities (verified against the real SDK, see
 * issue #4): `next` joins the running turn at its next tool boundary, a plain
 * message waits for the turn to end and starts the next one.
 */

export type AgentInput = { text: string; priority?: 'next' };

export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; output: string; isError: boolean }
  | {
      type: 'turn_end';
      outcome: 'done' | 'interrupted' | 'failed';
      error?: string;
      costUsd?: number;
      numTurns?: number;
      durationMs?: number;
    };

export interface AgentSession {
  send(input: AgentInput): void;
  /** Stops the running turn now (killing a running tool). Messages sent after it start the next turn. */
  interrupt(): Promise<void>;
  /** No more input: the event stream ends once the current turn does. */
  end(): void;
  readonly events: AsyncIterable<AgentEvent>;
}

export interface Agent {
  open(threadId: string): Promise<AgentSession>;
}
