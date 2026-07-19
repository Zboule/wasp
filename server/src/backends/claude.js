// Real agent backend: the official @ag-ui/claude-agent-sdk adapter, bridged from
// its RxJS observable to an async generator the host streams as SSE. Runs on the
// machine's Claude Code credentials (Max plan) like Nova — no API key required.
//
// The adapter auto-registers an `ag_ui_update_state` MCP tool whenever `state`
// is passed and emits STATE_SNAPSHOT events when the agent updates it — which is
// how agent actions reach the host app's UI.
import { EV, uid } from "../agui.js";

const adapters = new Map(); // one adapter per app: it holds SDK session cache

async function getAdapter(appKey, cfg) {
  if (adapters.has(appKey)) return adapters.get(appKey);
  let ClaudeAgentAdapter;
  try {
    ({ ClaudeAgentAdapter } = await import("@ag-ui/claude-agent-sdk"));
  } catch {
    throw new Error(
      "claude backend requires: npm i -w @wisp/server @ag-ui/claude-agent-sdk @ag-ui/client @anthropic-ai/claude-agent-sdk zod@^4 --legacy-peer-deps",
    );
  }
  // Everything except wisp-level keys passes straight through to the SDK
  // (model, systemPrompt, mcpServers, allowedTools, disallowedTools, tools, …).
  const { backend: _b, title: _t, initialState: _s, ...sdkOptions } = cfg;
  const adapter = new ClaudeAgentAdapter({
    agentId: cfg.agentId || appKey,
    model: cfg.model || "claude-haiku-4-5",
    systemPrompt: cfg.systemPrompt || "You are a helpful assistant.",
    // Isolation defaults for embedded copilots — an app config may override
    // deliberately, but out of the box a wisp agent must NOT see this
    // machine's user MCP servers (budget, nova, …) or filesystem settings.
    strictMcpConfig: true,
    settingSources: [],
    ...sdkOptions,
  });
  adapters.set(appKey, adapter);
  return adapter;
}

export async function* run(session, input, cfg) {
  const adapter = await getAdapter(cfg.agentId || "app", cfg);

  session.messages ||= [];
  session.state ??= structuredClone(cfg.initialState ?? {});
  const userText = input.message
    ? input.message
    : input.approve
      ? "Yes — approved, go ahead."
      : input.deny
        ? "No — cancel that."
        : null;
  if (userText) session.messages.push({ id: uid(), role: "user", content: userText });

  const buildInput = (withResume) => ({
    threadId: `${cfg.agentId || "app"}:${input.sessionId || "default"}`,
    runId: uid(),
    messages: session.messages,
    state: session.state,
    tools: [],
    // Per-run context (e.g. "current project id") — injected into the prompt
    // by the adapter. Host routes set input.context; cfg.context is static.
    context: input.context || cfg.context || [],
    // Durable continuity: the adapter only prompts with the LATEST user message
    // and relies on SDK-session resume for history. In-process it resumes from
    // its own cache (which overrides this); after a host restart we resume from
    // the persisted SDK session id captured below.
    forwardedProps: withResume && session.sdkSessionId ? { resume: session.sdkSessionId } : {},
  });

  // Tee events to keep the server-side session in sync (conversation memory +
  // shared state across turns), then yield them to the SSE stream untouched.
  let assistantBuf = "";
  const tee = (ev) => {
    if (ev.type === EV.STATE_SNAPSHOT) session.state = ev.snapshot;
    if (ev.type === EV.TEXT_MESSAGE_CONTENT) assistantBuf += ev.delta;
    if (ev.type === EV.TEXT_MESSAGE_END && assistantBuf.trim()) {
      session.messages.push({ id: uid(), role: "assistant", content: assistantBuf });
      assistantBuf = "";
    }
    // Capture the SDK session id (emitted on init) so hosts can persist it and
    // resume the conversation across restarts.
    if (ev.type === EV.CUSTOM && ev.name === "system:init") {
      const sid = ev.value?.session_id;
      if (sid) session.sdkSessionId = sid;
    }
  };

  // A persisted SDK session id can go stale (data moved to another machine,
  // SDK storage cleaned). The adapter reports that as a RUN_ERROR *event*, not
  // a thrown error — detect it, swallow it, and retry once without resume.
  let staleResume = false;

  // Bridge Observable -> async iterator.
  async function* consume(events$) {
    const queue = [];
    let wake = null;
    let done = false;
    let error = null;
    const sub = events$.subscribe({
      next: (e) => (queue.push(e), wake?.()),
      error: (e) => ((error = e), (done = true), wake?.()),
      complete: () => ((done = true), wake?.()),
    });
    try {
      for (;;) {
        if (queue.length) {
          const ev = queue.shift();
          if (
            ev.type === EV.RUN_ERROR &&
            session.sdkSessionId &&
            /no conversation found/i.test(ev.message || "")
          ) {
            staleResume = true;
            session.sdkSessionId = undefined;
            continue; // swallow — the caller retries fresh
          }
          tee(ev);
          yield ev;
          continue;
        }
        if (done) break;
        await new Promise((r) => (wake = r));
        wake = null;
      }
      if (error) throw error;
    } finally {
      sub.unsubscribe?.();
    }
  }

  try {
    yield* consume(adapter.run(buildInput(true)));
  } catch (e) {
    if (session.sdkSessionId && /no conversation found/i.test(e?.message || "")) {
      staleResume = true;
      session.sdkSessionId = undefined;
    } else {
      throw e;
    }
  }
  if (staleResume) yield* consume(adapter.run(buildInput(false)));
}
