// AG-UI event type constants. Mirrors @ag-ui/core's EventType enum exactly
// (verified against @ag-ui/core@0.0.57) so the client stays protocol-compatible
// with the official server adapter without bundling zod into the browser.
export const EV = Object.freeze({
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  STATE_DELTA: "STATE_DELTA",
  CUSTOM: "CUSTOM",
});

// Client-internal pseudo-events (never sent over the wire).
export const LOCAL = Object.freeze({
  USER: "__user__",
  CLEAR_APPROVAL: "__clear_approval__",
  RESET: "__reset__",
  HYDRATE: "__hydrate__", // restore a persisted conversation into the timeline
});
