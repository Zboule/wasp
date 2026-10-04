import type { Deliver, FeedEvent } from '@zboule/wasp-protocol';

export type TimelineItem =
  | { kind: 'user'; id: string; text: string; deliver: Deliver }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      args: string;
      argsUrl?: string;
      status: 'running' | 'done' | 'error';
      result?: string;
      resultUrl?: string;
    }
  | { kind: 'notice'; id: string; tone: 'info' | 'error'; text: string };

/**
 * Folds feed events into what a chat shows. Pure, so the same feed always gives
 * the same timeline: a reload, or a second tab, sees exactly this.
 * Text stays text: nothing from the agent is ever treated as HTML.
 */
export function applyEvent(timeline: TimelineItem[], event: FeedEvent, at: string): TimelineItem[] {
  const updateTool = (id: string, change: (t: Extract<TimelineItem, { kind: 'tool' }>) => TimelineItem) =>
    timeline.map((item) => (item.kind === 'tool' && item.id === id ? change(item) : item));

  switch (event.type) {
    case 'CUSTOM':
      if (event.name === 'wasp.message') {
        const { messageId, text, deliver } = event.value;
        return [...timeline, { kind: 'user', id: messageId, text, deliver }];
      }
      return [...timeline, { kind: 'notice', id: at, tone: 'error', text: `A message could not be delivered (${event.value.reason}).` }];
    case 'TEXT_MESSAGE_START':
      return [...timeline, { kind: 'assistant', id: event.messageId, text: '' }];
    case 'TEXT_MESSAGE_CONTENT':
      return timeline.map((item) => (item.kind === 'assistant' && item.id === event.messageId ? { ...item, text: item.text + event.delta } : item));
    case 'TOOL_CALL_START':
      return [...timeline, { kind: 'tool', id: event.toolCallId, name: event.toolCallName, args: '', status: 'running' }];
    case 'TOOL_CALL_ARGS':
      return updateTool(event.toolCallId, (t) => ({ ...t, args: t.args + event.delta, ...(event.argsRef ? { argsUrl: event.argsRef } : {}) }));
    case 'TOOL_CALL_RESULT':
      return updateTool(event.toolCallId, (t) => ({
        ...t,
        status: event.isError ? 'error' : 'done',
        result: event.content,
        ...(event.outputRef ? { resultUrl: event.outputRef } : {})
      }));
    case 'RUN_FINISHED':
      return event.result.outcome === 'interrupted' ? [...timeline, { kind: 'notice', id: at, tone: 'info', text: 'Interrupted.' }] : timeline;
    case 'RUN_ERROR':
      return [...timeline, { kind: 'notice', id: at, tone: 'error', text: event.message }];
    default:
      return timeline;
  }
}
