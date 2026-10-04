// Headless chat store: reduces AG-UI events into a subscribable state tree.
// No rendering, no framework — this is the "state management" layer the UI sits on.
import { createStore } from "zustand/vanilla";
import { EV, LOCAL } from "./events.js";

const INITIAL = {
  status: "idle", // idle | running | error
  error: null,
  pendingApproval: null, // { id, summary, cost } when the agent is waiting on a Go
  appState: {}, // shared app state the agent mutates (STATE_SNAPSHOT/DELTA)
  timeline: [], // ordered: {kind:'user'|'assistant'|'tool', ...}
};

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
const mapTool = (timeline, id, fn) =>
  timeline.map((t) => (t.kind === "tool" && t.id === id ? fn(t) : t));

// Pure reducer: (state, event) -> partial state. Exported for testing.
export function reduce(s, ev) {
  switch (ev.type) {
    case LOCAL.USER:
      return {
        timeline: [
          ...s.timeline,
          { kind: "user", id: ev.id, text: ev.text, attachments: ev.attachments || [] },
        ],
      };
    case LOCAL.CLEAR_APPROVAL:
      return { pendingApproval: null };
    case LOCAL.RESET:
      return { ...INITIAL };
    case LOCAL.HYDRATE:
      return { timeline: ev.timeline };

    case EV.RUN_STARTED:
      return { status: "running", error: null };
    case EV.RUN_FINISHED:
      return { status: "idle" };
    case EV.RUN_ERROR:
      return { status: "error", error: ev.message || "Run failed" };

    case EV.TEXT_MESSAGE_START:
      return { timeline: [...s.timeline, { kind: "assistant", id: ev.messageId, text: "" }] };
    case EV.TEXT_MESSAGE_CONTENT:
      return {
        timeline: s.timeline.map((t) =>
          t.kind === "assistant" && t.id === ev.messageId ? { ...t, text: t.text + ev.delta } : t,
        ),
      };
    case EV.TEXT_MESSAGE_END:
      return {};

    // The model's visible thinking: streamed like text, rendered as its own item.
    case EV.REASONING_MESSAGE_START:
      return { timeline: [...s.timeline, { kind: "thinking", id: ev.messageId, text: "", done: false }] };
    case EV.REASONING_MESSAGE_CONTENT:
      return {
        timeline: s.timeline.map((t) =>
          t.kind === "thinking" && t.id === ev.messageId ? { ...t, text: t.text + ev.delta } : t,
        ),
      };
    case EV.REASONING_MESSAGE_END:
      return {
        timeline: s.timeline.map((t) =>
          t.kind === "thinking" && t.id === ev.messageId ? { ...t, done: true } : t,
        ),
      };

    case EV.TOOL_CALL_START:
      return {
        timeline: [
          ...s.timeline,
          { kind: "tool", id: ev.toolCallId, name: ev.toolCallName, argsText: "", args: null, status: "running", result: null },
        ],
      };
    case EV.TOOL_CALL_ARGS:
      return { timeline: mapTool(s.timeline, ev.toolCallId, (t) => ({ ...t, argsText: t.argsText + ev.delta })) };
    case EV.TOOL_CALL_END:
      return { timeline: mapTool(s.timeline, ev.toolCallId, (t) => ({ ...t, args: safeParse(t.argsText) })) };
    case EV.TOOL_CALL_RESULT:
      return { timeline: mapTool(s.timeline, ev.toolCallId, (t) => ({ ...t, status: "done", result: ev.content })) };

    case EV.STATE_SNAPSHOT:
      return { appState: ev.snapshot ?? {} };
    case EV.STATE_DELTA:
      return { appState: { ...s.appState, ...(ev.delta ?? {}) } };

    case EV.CUSTOM:
      if (ev.name === "approval_request") return { pendingApproval: ev.value };
      return {};

    default:
      return {};
  }
}

export function createChatStore() {
  return createStore((set) => ({
    ...INITIAL,
    dispatch: (ev) => set((s) => reduce(s, ev)),
  }));
}
