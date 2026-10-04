/**
 * The feed is a log of AG-UI events (https://docs.ag-ui.com), so any AG-UI
 * client can render it. Wasp adds CUSTOM events for what AG-UI has no word for:
 * a user message leaving the queue, and one that could not be delivered.
 */

export const EventType = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  CUSTOM: 'CUSTOM'
} as const;

export type RunOutcome = 'done' | 'interrupted';

export type RunStarted = { type: 'RUN_STARTED'; threadId: string; runId: string };
export type RunFinished = { type: 'RUN_FINISHED'; threadId: string; runId: string; result: RunResult };
export type RunError = { type: 'RUN_ERROR'; message: string; code?: string };
export type RunResult = { outcome: RunOutcome; costUsd?: number; numTurns?: number; durationMs?: number };

export type TextMessageStart = { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' };
export type TextMessageContent = { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string };
export type TextMessageEnd = { type: 'TEXT_MESSAGE_END'; messageId: string };

export type ToolCallStart = { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string };
export type ToolCallArgs = {
  type: 'TOOL_CALL_ARGS';
  toolCallId: string;
  /** The arguments as JSON, or a preview when they were offloaded: see `argsRef`. */
  delta: string;
  /** Set when the arguments were too large to keep inline. The client resolves it to a URL. */
  argsRef?: string;
};
export type ToolCallEnd = { type: 'TOOL_CALL_END'; toolCallId: string };
export type ToolCallResult = {
  type: 'TOOL_CALL_RESULT';
  messageId: string;
  toolCallId: string;
  /** The full output, or a preview when it was offloaded: see `outputRef`. */
  content: string;
  isError?: boolean;
  /** Set when the output was too large (or an image) to keep inline. The client resolves it to a URL. */
  outputRef?: string;
};

/** A queued user message reached the agent. */
export type MessageDelivered = {
  type: 'CUSTOM';
  name: 'wasp.message';
  value: { messageId: string; text: string; deliver: Deliver };
};

/** A queued user message could not be delivered (e.g. its caller token expired). */
export type MessageFailed = {
  type: 'CUSTOM';
  name: 'wasp.message_failed';
  value: { messageId: string; reason: 'token_expired' | 'invalid' };
};

export type FeedEvent =
  | RunStarted
  | RunFinished
  | RunError
  | TextMessageStart
  | TextMessageContent
  | TextMessageEnd
  | ToolCallStart
  | ToolCallArgs
  | ToolCallEnd
  | ToolCallResult
  | MessageDelivered
  | MessageFailed;

/**
 * - `later`: waits for the current turn to end (FIFO).
 * - `asap`: joins the running turn at its next tool boundary.
 * - `now`: interrupts the running turn and goes first.
 * On an idle thread all three start a turn.
 */
export type Deliver = 'later' | 'asap' | 'now';
