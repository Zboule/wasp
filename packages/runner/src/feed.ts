import type { FeedEvent } from '@zboule/wasp-protocol';

import type { AgentEvent } from './agent.ts';

/** An agent event as AG-UI feed events. `runId` is the current turn's. */
export function toFeedEvents(event: AgentEvent, ctx: { threadId: string; runId: string; newId: () => string }): FeedEvent[] {
  const { threadId, runId, newId } = ctx;
  switch (event.type) {
    case 'turn_start':
      return [{ type: 'RUN_STARTED', threadId, runId }];
    case 'text': {
      const messageId = newId();
      return [
        { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: event.text },
        { type: 'TEXT_MESSAGE_END', messageId }
      ];
    }
    case 'tool_call':
      return [
        { type: 'TOOL_CALL_START', toolCallId: event.id, toolCallName: event.name },
        { type: 'TOOL_CALL_ARGS', toolCallId: event.id, delta: JSON.stringify(event.input ?? {}) },
        { type: 'TOOL_CALL_END', toolCallId: event.id }
      ];
    case 'tool_result':
      return [
        {
          type: 'TOOL_CALL_RESULT',
          messageId: newId(),
          toolCallId: event.toolCallId,
          content: event.output,
          ...(event.isError ? { isError: true } : {})
        }
      ];
    case 'turn_end':
      if (event.outcome === 'failed') return [{ type: 'RUN_ERROR', message: event.error ?? 'The turn failed' }];
      return [
        {
          type: 'RUN_FINISHED',
          threadId,
          runId,
          result: {
            outcome: event.outcome,
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
            ...(event.numTurns !== undefined ? { numTurns: event.numTurns } : {}),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})
          }
        }
      ];
  }
}
