// Server-side AG-UI event constants + streaming helpers. Self-contained so the
// host has no dependency on the client packages. Constants mirror @ag-ui/core.
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
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  STATE_DELTA: "STATE_DELTA",
  CUSTOM: "CUSTOM",
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () => globalThis.crypto.randomUUID();

// Stream a text message token-by-token as AG-UI text events.
export async function* streamText(text, { chunk = 4, delay = 16 } = {}) {
  const id = uid();
  yield { type: EV.TEXT_MESSAGE_START, messageId: id, role: "assistant" };
  const parts = text.split(/(\s+)/);
  let buf = "";
  for (const p of parts) {
    buf += p;
    if (buf.length >= chunk) {
      yield { type: EV.TEXT_MESSAGE_CONTENT, messageId: id, delta: buf };
      buf = "";
      await sleep(delay);
    }
  }
  if (buf) yield { type: EV.TEXT_MESSAGE_CONTENT, messageId: id, delta: buf };
  yield { type: EV.TEXT_MESSAGE_END, messageId: id };
}

// Stream a tool call's START + args (JSON, chunked) + END. Caller emits the
// result afterwards (so it can mutate state in between).
export async function* streamToolCall(id, name, args, { delay = 12 } = {}) {
  yield { type: EV.TOOL_CALL_START, toolCallId: id, toolCallName: name };
  const s = JSON.stringify(args);
  for (let i = 0; i < s.length; i += 5) {
    yield { type: EV.TOOL_CALL_ARGS, toolCallId: id, delta: s.slice(i, i + 5) };
    await sleep(delay);
  }
  yield { type: EV.TOOL_CALL_END, toolCallId: id };
}
