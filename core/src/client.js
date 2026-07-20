// Wisp client: connects the headless store to an AG-UI SSE endpoint.
// Owns transport (fetch + SSE parsing); exposes send/approve/deny/interrupt.
import { createChatStore } from "./store.js";
import { EV, LOCAL } from "./events.js";

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? "id-" + Math.random().toString(36).slice(2);

// Parse an SSE byte stream, invoking onEvent(parsedJson) per `data:` frame.
async function pumpSSE(res, onEvent, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal?.aborted) return;
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (json) onEvent(JSON.parse(json));
    }
  }
}

export function createWispClient({ endpoint = "", app, sessionId, historyUrl, onAppState, onError } = {}) {
  const store = createChatStore();
  let controller = null;

  // Restore a persisted conversation (if the host app provides one). Only text
  // turns are restored; tool chips belong to the live run that produced them.
  if (historyUrl) {
    fetch(historyUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => {
        if (!h?.messages?.length) return;
        if (store.getState().timeline.length) return; // don't clobber a live conversation
        const timeline = h.messages.map((m) => ({
          kind: m.role === "user" ? "user" : "assistant",
          id: uid(),
          text: m.text || "",
        }));
        store.getState().dispatch({ type: LOCAL.HYDRATE, timeline });
      })
      .catch(() => {});
  }

  async function fetchHistory() {
    if (!historyUrl) return null;
    try {
      const r = await fetch(historyUrl);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }
  function hydrateFrom(h) {
    const timeline = h.messages.map((m) => ({
      kind: m.role === "user" ? "user" : "assistant",
      id: uid(),
      text: m.text || "",
      attachments: [],
    }));
    store.getState().dispatch({ type: LOCAL.HYDRATE, timeline });
  }

  // The connection died mid-run (phone backgrounded, network blip) but the
  // agent keeps working server-side. Poll history until its answer lands,
  // then swap it in — instead of surfacing a scary dead-end error.
  async function recoverViaHistory() {
    const seen = new Set(
      store.getState().timeline.filter((t) => t.kind === "assistant" && t.text).map((t) => t.text),
    );
    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      const h = await fetchHistory();
      const last = h?.messages?.[h.messages.length - 1];
      if (last && last.role === "assistant" && last.text && !seen.has(last.text)) {
        hydrateFrom(h);
        store.getState().dispatch({ type: EV.RUN_FINISHED });
        return;
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    store.getState().dispatch({ type: EV.RUN_ERROR, message: "Connection lost. Reload to sync." });
  }

  async function run(body) {
    controller = new AbortController();
    const { dispatch } = store.getState();
    dispatch({ type: EV.RUN_STARTED });
    try {
      const res = await fetch(`${endpoint}/agent/${app}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...body }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pumpSSE(
        res,
        (ev) => {
          dispatch(ev);
          // Notify the host app on tool START too — a tool may kick off slow
          // server-side work the app wants to show a loading state for.
          if (
            ev.type === EV.STATE_SNAPSHOT ||
            ev.type === EV.STATE_DELTA ||
            ev.type === EV.TOOL_CALL_START ||
            ev.type === EV.TOOL_CALL_RESULT
          )
            onAppState?.(store.getState().appState);
        },
        controller.signal,
      );
      // Backends aren't required to emit RUN_FINISHED; stream end means done.
      if (store.getState().status === "running") dispatch({ type: EV.RUN_FINISHED });
    } catch (e) {
      if (e.name === "AbortError") {
        store.getState().dispatch({ type: EV.RUN_FINISHED });
      } else if (historyUrl) {
        await recoverViaHistory(); // agent keeps working server-side
      } else {
        store.getState().dispatch({ type: EV.RUN_ERROR, message: e.message });
        onError?.(e);
      }
    }
  }

  return {
    store,
    // attachments: [{file, url}] — `file` goes to the backend, `url` renders locally
    send(text, attachments = []) {
      const t = String(text || "").trim();
      if (!t && !attachments.length) return;
      store.getState().dispatch({
        type: LOCAL.USER,
        id: uid(),
        text: t,
        attachments: attachments.map((a) => a.url),
      });
      return run({ message: t, attachments: attachments.map((a) => a.file) });
    },
    approve() {
      const p = store.getState().pendingApproval;
      store.getState().dispatch({ type: LOCAL.CLEAR_APPROVAL });
      return run({ approve: p?.id ?? true });
    },
    deny() {
      store.getState().dispatch({ type: LOCAL.CLEAR_APPROVAL });
      return run({ deny: true });
    },
    interrupt() {
      controller?.abort();
    },
    // Re-sync from persisted history (e.g. when the panel is reopened after
    // the app was backgrounded while a run completed server-side).
    async refreshHistory() {
      if (store.getState().status === "running") return;
      const h = await fetchHistory();
      if (!h?.messages?.length) return;
      const textItems = store
        .getState()
        .timeline.filter((t) => (t.kind === "user" || t.kind === "assistant") && t.text).length;
      if (h.messages.length > textItems) hydrateFrom(h);
    },
    reset() {
      store.getState().dispatch({ type: LOCAL.RESET });
    },
  };
}
