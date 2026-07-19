// Mock agent backend: a scripted "notes copilot" that emits real AG-UI events.
// Demonstrates streaming text, tool calls (with streaming args + results),
// shared app-state sync, and a human-in-the-loop approval gate — with no external
// dependencies, billing, or model. Swap for backends/claude.js for a real agent.
import { EV, sleep, uid, streamText, streamToolCall } from "../agui.js";

const snap = (s) => ({ notes: s.notes, published: !!s.published });

export async function* run(session, input) {
  yield { type: EV.RUN_STARTED };
  session.notes ||= [];

  // --- continuation after an approval gate ---
  if (input.deny) {
    yield* streamText("No problem — I won't publish. Anything else you'd like to add?");
    yield { type: EV.RUN_FINISHED };
    return;
  }
  if (input.approve) {
    yield* streamText("Publishing your notes now…");
    const tid = uid();
    yield* streamToolCall(tid, "publish_notes", { count: session.notes.length });
    await sleep(220);
    session.published = true;
    yield { type: EV.STATE_SNAPSHOT, snapshot: snap(session) };
    yield {
      type: EV.TOOL_CALL_RESULT,
      toolCallId: tid,
      content: JSON.stringify({ ok: true, url: "https://example.com/published" }),
    };
    yield* streamText(`Done — published ${session.notes.length} notes. 🎉`);
    yield { type: EV.RUN_FINISHED };
    return;
  }

  // --- normal turn ---
  const msg = String(input.message || "").trim();
  const wantsPublish = /\b(publish|finish|done|share|ship)\b/i.test(msg);
  const note = msg.replace(/\s*\b(please|now|and publish|then publish)\b\s*$/i, "").replace(/[.!]+$/, "");

  yield* streamText("Got it — capturing that as a note.");

  const tid = uid();
  yield* streamToolCall(tid, "add_note", { text: note });
  await sleep(160);
  session.notes.push(note);
  yield { type: EV.STATE_SNAPSHOT, snapshot: snap(session) };
  yield {
    type: EV.TOOL_CALL_RESULT,
    toolCallId: tid,
    content: JSON.stringify({ added: true, total: session.notes.length }),
  };

  if (wantsPublish) {
    yield* streamText(
      `You've got ${session.notes.length} note${session.notes.length === 1 ? "" : "s"}. Publishing is permanent, so I'll check with you first.`,
    );
    yield {
      type: EV.CUSTOM,
      name: "approval_request",
      value: { id: uid(), summary: `Publish ${session.notes.length} notes`, cost: "irreversible" },
    };
    yield { type: EV.RUN_FINISHED };
    return;
  }

  yield* streamText(
    `Added — you now have ${session.notes.length} note${session.notes.length === 1 ? "" : "s"}. Tell me another, or say “publish” when you're ready.`,
  );
  yield { type: EV.RUN_FINISHED };
}
