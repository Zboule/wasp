import type { Deliver, FeedEvent } from '@zboule/wasp-protocol';

export type ToolItem = {
  kind: 'tool';
  id: string;
  name: string;
  args: string;
  argsUrl?: string;
  /** `stopped`: the run ended (interrupted, or failed) before the tool answered. */
  status: 'running' | 'done' | 'error' | 'stopped';
  result?: string;
  resultUrl?: string;
};

/**
 * What a notice says is a code, not a sentence, so the UI can translate it.
 * `detail` carries the text the run produced (an error message), if any.
 */
export type NoticeCode = 'interrupted' | 'undeliverable' | 'error';

export type TimelineItem =
  | { kind: 'user'; id: string; text: string; deliver: Deliver }
  | { kind: 'assistant'; id: string; text: string }
  | ToolItem
  | { kind: 'notice'; id: string; code: NoticeCode; detail?: string };

/**
 * Folds feed events into what a chat shows. Pure, so the same feed always gives
 * the same timeline: a reload, or a second tab, sees exactly this.
 * Text stays text: nothing from the agent is ever treated as HTML.
 */
export function applyEvent(timeline: TimelineItem[], event: FeedEvent, at: string): TimelineItem[] {
  const updateTool = (id: string, change: (t: ToolItem) => TimelineItem) =>
    timeline.map((item) => (item.kind === 'tool' && item.id === id ? change(item) : item));

  switch (event.type) {
    case 'CUSTOM':
      if (event.name === 'wasp.message') {
        const { messageId, text, deliver } = event.value;
        return [...timeline, { kind: 'user', id: messageId, text, deliver }];
      }
      return [
        ...timeline,
        {
          kind: 'notice',
          id: at,
          code: 'undeliverable',
          detail: event.value.reason
        }
      ];
    case 'TEXT_MESSAGE_START':
      return [...timeline, { kind: 'assistant', id: event.messageId, text: '' }];
    case 'TEXT_MESSAGE_CONTENT':
      return timeline.map((item) => (item.kind === 'assistant' && item.id === event.messageId ? { ...item, text: item.text + event.delta } : item));
    case 'TOOL_CALL_START':
      return [
        ...timeline,
        {
          kind: 'tool',
          id: event.toolCallId,
          name: event.toolCallName,
          args: '',
          status: 'running'
        }
      ];
    case 'TOOL_CALL_ARGS':
      return updateTool(event.toolCallId, (t) => ({
        ...t,
        args: t.args + event.delta,
        ...(event.argsRef ? { argsUrl: event.argsRef } : {})
      }));
    case 'TOOL_CALL_RESULT':
      return updateTool(event.toolCallId, (t) => ({
        ...t,
        status: event.isError ? 'error' : 'done',
        result: event.content,
        ...(event.outputRef ? { resultUrl: event.outputRef } : {})
      }));
    case 'RUN_FINISHED':
      return event.result.outcome === 'interrupted' ? [...settle(timeline), { kind: 'notice', id: at, code: 'interrupted' }] : settle(timeline);
    case 'RUN_ERROR':
      return [...settle(timeline), { kind: 'notice', id: at, code: 'error', detail: event.message }];
    default:
      return timeline;
  }
}

/** A run that ended leaves no tool running: one that never answered was stopped. */
function settle(timeline: TimelineItem[]): TimelineItem[] {
  return timeline.some((i) => i.kind === 'tool' && i.status === 'running')
    ? timeline.map((i) => (i.kind === 'tool' && i.status === 'running' ? { ...i, status: 'stopped' } : i))
    : timeline;
}
