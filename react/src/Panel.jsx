import { useEffect, useRef, useState } from "react";
import { useWisp } from "./useWisp.js";

// Minimal markdown → HTML for assistant messages. Escapes first, then applies
// its own tags, so the output is safe to inject. Supports: paragraphs, bold,
// italic, inline code, fenced code, headings, bullet/numbered lists, links.
function mdToHtml(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|[.,!?;:]|$)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null; // "ul" | "ol"
  let para = [];
  let code = null; // array of code lines when inside a fence
  const closePara = () => {
    if (para.length) out.push(`<p>${inline(para.join("<br/>"))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of esc(src).split("\n")) {
    if (raw.trim().startsWith("```")) {
      if (code) {
        out.push(`<pre>${code.join("\n")}</pre>`);
        code = null;
      } else {
        closePara();
        closeList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    const h = line.match(/^#{1,4}\s+(.*)/);
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (!line.trim()) {
      closePara();
      closeList();
    } else if (h) {
      closePara();
      closeList();
      out.push(`<p class="md-h">${inline(h[1])}</p>`);
    } else if (ul || ol) {
      closePara();
      const want = ul ? "ul" : "ol";
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else {
      if (list) closeList();
      para.push(line);
    }
  }
  if (code) out.push(`<pre>${code.join("\n")}</pre>`);
  closePara();
  closeList();
  return out.join("");
}

// Renders a tool result: an image if it looks like one, else text.
function ToolResult({ result }) {
  let val = result;
  if (typeof result === "string") {
    try {
      val = JSON.parse(result);
    } catch {}
  }
  const url = val && typeof val === "object" ? val.url || val.image : null;
  if (url && /^https?:|^\/|\.(png|jpe?g|webp)$/i.test(url))
    return <img className="wisp-tool-img" src={url} alt="" />;
  const text = typeof val === "string" ? val : JSON.stringify(val);
  return <div className="wisp-tool-result">{text}</div>;
}

// The model's thinking: streams live (open, dimmed), collapses when done.
// Models with hidden reasoning stream EMPTY thinking — render nothing for those
// bodies (a bare "thinking…" line live, nothing once done).
function ThinkingChip({ item }) {
  const [open, setOpen] = useState(false);
  if (!item.done)
    return (
      <div className="wisp-think live">
        <div className="wisp-think-head">
          <span className="wisp-think-ico">💭</span> thinking…
        </div>
        {item.text.trim() ? <div className="wisp-think-body streaming">{item.text}</div> : null}
      </div>
    );
  if (!item.text.trim()) return null;
  return (
    <div className="wisp-think">
      <button className="wisp-think-head" onClick={() => setOpen((o) => !o)}>
        <span className="wisp-think-ico">💭</span> thought
        <span className="wisp-tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="wisp-think-body">{item.text}</div>}
    </div>
  );
}

// Persistent activity pill while a run is live — the "something is happening"
// signal, incl. the silent seconds before the first event arrives.
function WorkingPill({ timeline }) {
  const last = timeline[timeline.length - 1];
  const label =
    last?.kind === "thinking" && !last.done
      ? "thinking…"
      : last?.kind === "tool" && last.status === "running"
        ? "using tools…"
        : "working…";
  return (
    <div className="wisp-working">
      <span className="wisp-working-dots">
        <i />
        <i />
        <i />
      </span>
      {label}
    </div>
  );
}

function ToolChip({ item }) {
  const [open, setOpen] = useState(false);
  const args = item.args ?? (item.argsText ? item.argsText : null);
  return (
    <div className={`wisp-tool ${item.status}`}>
      <button className="wisp-tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="wisp-tool-ico">{item.status === "running" ? <span className="wisp-spin" /> : "✓"}</span>
        <span className="wisp-tool-name">{item.name}</span>
        {item.status === "running" && <span className="wisp-tool-sub">working…</span>}
        <span className="wisp-tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="wisp-tool-body">
          {args && (
            <pre className="wisp-tool-args">{typeof args === "string" ? args : JSON.stringify(args, null, 2)}</pre>
          )}
          {item.result != null && <ToolResult result={item.result} />}
        </div>
      )}
    </div>
  );
}

export function Panel({ title = "Assistant", placeholder = "Ask the agent…", suggestions = [], uploadUrl, ...config }) {
  const wisp = useWisp(config);
  // Draft lives in sessionStorage so no remount/reload/late agent event can
  // wipe half-typed text.
  const draftKey = `wisp-draft:${config.sessionId || "default"}`;
  const [text, setTextState] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) || "";
    } catch {
      return "";
    }
  });
  const setText = (v) => {
    setTextState(v);
    try {
      v ? sessionStorage.setItem(draftKey, v) : sessionStorage.removeItem(draftKey);
    } catch {}
  };
  const [pending, setPending] = useState([]); // uploaded, not yet sent
  const [showJump, setShowJump] = useState(false);
  const nearBottom = useRef(true);
  const fileRef = useRef(null);
  const scroller = useRef(null);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottom.current = away < 160;
    setShowJump(away > 300);
  };
  const jumpDown = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  useEffect(() => {
    // follow the stream only while the user is already at the bottom —
    // reading upthread must not be yanked away
    const el = scroller.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [wisp.timeline, wisp.pendingApproval, wisp.status]);

  async function onPick(e) {
    const files = [...e.target.files];
    e.target.value = "";
    for (const f of files) {
      try {
        const data = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(",", 2)[1]);
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        const resp = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: f.name, mime: f.type, data }),
        });
        if (!resp.ok) throw new Error("upload failed");
        const up = await resp.json();
        setPending((p) => [...p, { file: up.file, url: up.url, name: f.name }]);
      } catch {
        /* silently skip failed files */
      }
    }
  }

  const running = wisp.status === "running";
  const submit = (e) => {
    e?.preventDefault?.();
    if (running) return wisp.interrupt(); // send button doubles as stop
    if (!text.trim() && !pending.length) return;
    wisp.send(text, pending);
    setText("");
    setPending([]);
  };

  const empty = wisp.timeline.length === 0;

  return (
    <div className="wisp">
      <div className="wisp-header">
        <span className="wisp-dot" />
        <span className="wisp-title">{title}</span>
      </div>

      <div className="wisp-scrollwrap">
      <div className="wisp-scroll" ref={scroller} onScroll={onScroll}>
        {empty && (
          <div className="wisp-empty">
            <div className="wisp-empty-em">✨</div>
            <p>How can I help?</p>
            {suggestions.length > 0 && (
              <div className="wisp-sugg">
                {suggestions.map((s, i) => (
                  <button key={i} onClick={() => wisp.send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {wisp.timeline.map((item, i) => {
          if (item.kind === "user")
            return (
              <div key={item.id} className="wisp-msg user">
                {item.attachments?.length ? (
                  <div className="wisp-att">
                    {item.attachments.map((u, j) => (
                      <img key={j} src={u} alt="" />
                    ))}
                  </div>
                ) : null}
                {item.text}
              </div>
            );
          if (item.kind === "assistant") {
            if (!item.text.trim()) {
              // only show a caret for the message currently being streamed
              const isLast = i === wisp.timeline.length - 1;
              return isLast && wisp.status === "running" ? (
                <div key={item.id} className="wisp-msg assistant">
                  <span className="wisp-caret" />
                </div>
              ) : null;
            }
            return (
              <div
                key={item.id}
                className="wisp-msg assistant md"
                dangerouslySetInnerHTML={{ __html: mdToHtml(item.text) }}
              />
            );
          }
          if (item.kind === "thinking") return <ThinkingChip key={item.id} item={item} />;
          return <ToolChip key={item.id} item={item} />;
        })}

        {(() => {
          // the pill covers silent gaps only — when the last item already
          // shows a live indicator (thinking chip, running tool), skip it
          const last = wisp.timeline[wisp.timeline.length - 1];
          const lastLive =
            (last?.kind === "thinking" && !last.done) ||
            (last?.kind === "tool" && last.status === "running");
          return wisp.status === "running" && !lastLive ? <WorkingPill timeline={wisp.timeline} /> : null;
        })()}

        {wisp.pendingApproval && (
          <div className="wisp-approval">
            <div className="wisp-approval-txt">
              {wisp.pendingApproval.summary}
              {wisp.pendingApproval.cost ? <span className="wisp-cost"> · {wisp.pendingApproval.cost}</span> : null}
            </div>
            <div className="wisp-approval-actions">
              <button className="wisp-btn primary" onClick={wisp.approve}>
                Go
              </button>
              <button className="wisp-btn" onClick={wisp.deny}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {wisp.status === "error" && <div className="wisp-error">{wisp.error}</div>}
      </div>
      {showJump && (
        <button type="button" className="wisp-jump" onClick={jumpDown} aria-label="Scroll to latest">
          ↓
        </button>
      )}
      </div>

      {pending.length > 0 && (
        <div className="wisp-pending">
          {pending.map((p, i) => (
            <div key={i} className="wisp-pending-th">
              <img src={p.url} alt={p.name} />
              <button onClick={() => setPending((x) => x.filter((_, j) => j !== i))} aria-label="Remove">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <form className="wisp-input" onSubmit={submit}>
        <textarea
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit(e);
          }}
        />
        <div className="wisp-input-row">
          {uploadUrl && (
            <>
              <button
                type="button"
                className="wisp-attach"
                aria-label="Attach image"
                onClick={() => fileRef.current?.click()}
              >
                +
              </button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={onPick} />
            </>
          )}
          <span className="wisp-input-sp" />
          <button
            className={running ? "wisp-send stop" : "wisp-send"}
            type="submit"
            disabled={!running && !text.trim() && !pending.length}
            aria-label={running ? "Stop" : "Send"}
          >
            {running ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect width="12" height="12" rx="2.5" fill="currentColor" />
              </svg>
            ) : (
              "↑"
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
