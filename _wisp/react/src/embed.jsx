// No-build embed entry: bundled by esbuild into a self-contained IIFE (window.Wisp).
// Lets any app drop in the panel with one <script> tag + Wisp.mount(el, opts).
import { createRoot } from "react-dom/client";
import { Panel } from "./Panel.jsx";
import { useWisp } from "./useWisp.js";
import css from "./styles.css";

let injected = false;
function injectCss() {
  if (injected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.setAttribute("data-wisp", "");
  el.textContent = css;
  document.head.appendChild(el);
  injected = true;
}

export function mount(el, opts = {}) {
  injectCss();
  const target = typeof el === "string" ? document.querySelector(el) : el;
  const root = createRoot(target);
  let client = null;
  root.render(<Panel {...opts} onClientReady={(c) => (client = c)} />);
  return {
    unmount: () => root.unmount(),
    refreshHistory: () => client?.refreshHistory?.(),
    isBusy: () => {
      const s = client?.store?.getState?.();
      return s?.status === "running" || !!s?.pendingApproval;
    },
  };
}

export { Panel, useWisp };
