# wisp

Generic, embeddable AI-agent chat: a reusable client + server pair for putting a
conversational agent (with tools, streaming, and approval gates) inside any app.
First consumer: **book-builder**'s AI-assisted book creation. Future candidates:
any jorna app that wants an embedded copilot.

## Design principles

1. **Protocol first, not framework first.** Client and server speak
   [AG-UI](https://docs.ag-ui.com) — the open agent↔user event protocol (adopted
   in 2026 by AWS AgentCore, Microsoft Agent Framework, Google ADK). Typed
   events over SSE: `TEXT_MESSAGE_*`, `TOOL_CALL_START/ARGS/END`,
   `STATE_DELTA`, `RUN_STARTED/FINISHED`. Either side is replaceable.
2. **State management is strictly separated from rendering.** The headless core
   owns all chat state; UI packages only subscribe and render. Any framework —
   or no framework — can sit on top.
3. **Buy the commodity, build the glue.** Custom code is limited to: the host
   config layer, the store reducer, and the UI skin.

## Architecture

```
┌────────────────────────────── consumer app (e.g. book-builder SPA) ─┐
│  <script src="wisp.js"> → Wisp.mount(el, {endpoint,…})   │
│        │ renders                                                    │
│  ┌─ react/ ────────────┐      ┌─ core/ (headless) ────────────────┐ │
│  │ <Wisp/>        │─sub──│ zustand vanilla store             │ │
│  │ useAgent() hooks    │      │ messages · streaming buffers ·    │ │
│  │ (rendering ONLY)    │      │ tool timeline · run status ·      │ │
│  └─────────────────────┘      │ shared app state · approvals      │ │
│                               │   ▲ AG-UI events (@ag-ui/client)  │ │
└───────────────────────────────┼───┼─────────────────────────────────┘
                                    │ SSE
┌─ server/ ──────────────────────────────────────────────────────────┐
│ config-driven host (per-app: system prompt, MCP servers, model,    │
│ allowed tools, cwd, session store)                                 │
│   → @ag-ui/claude-agent-sdk adapter (official)                     │
│   → @anthropic-ai/claude-agent-sdk (Max-plan auth like Nova,       │
│     or ANTHROPIC_API_KEY)                                          │
│   → app's MCP servers (e.g. book-builder mcp.js, 13 tools)         │
└────────────────────────────────────────────────────────────────────┘
```

### Packages (monorepo, npm workspaces)

| Package | Deps | Role |
|---|---|---|
| `server/` | `@ag-ui/claude-agent-sdk`, `@anthropic-ai/claude-agent-sdk`, `zod` | HTTP host: `POST /agent/:app/run` (SSE out), interrupts, per-session persistence (jsonl), app registry from `apps.config.js` |
| `core/` | `@ag-ui/client`, `zustand` (vanilla) | Headless client: connect, send, interrupt, approve/deny; reduces AG-UI events into a subscribable store; RxJS kept internal |
| `react/` | `react`, `core` | `useWisp(config)` + `<Wisp/>` (message list, streaming text, tool-activity chips with live args, approval buttons, error/retry). Ships as ESM **and** as a self-contained IIFE bundle for no-build apps |
| `examples/book-builder/` | — | Wiring: app config with book-builder's `mcp.js`, the author-brain system prompt, and the SPA embed snippet |

### Key mechanics

- **Tool-activity rendering:** AG-UI streams tool args as they generate; the
  store keeps a per-message tool timeline so the UI can show
  "🎨 generate_style — painting…" chips that resolve to results (and, for
  book-builder, image thumbnails) when `TOOL_CALL_END` lands.
- **Approval gates (human-in-the-loop):** the adapter pauses the stream on
  frontend tools; we model "propose plan → user taps Go" as a frontend
  `request_approval` tool. Cheap config mutations run free; generation bursts
  ask first (they cost real money).
- **App state sync:** consumers subscribe to tool-completion/`STATE_DELTA`
  events from the store (e.g. book-builder refetches the project and re-renders
  after any mutating tool).
- **Sessions:** one chat per (app, session id) — book-builder passes the project
  id, so the conversation lives with the book and survives reloads.
- **Auth:** no ANTHROPIC_API_KEY required — the Agent SDK uses the machine's
  Claude Code credentials (Max plan), same as Nova. Key env var still respected
  when set.

## Status

- [x] Research: protocol + library evaluation (AG-UI chosen; official
  `@ag-ui/claude-agent-sdk` adapter verified — lifecycle, interrupts, streaming
  tool args, HITL approval, MCP tools)
- [x] Monorepo scaffolded (npm workspaces: core, react, server)
- [x] `core/`: headless zustand store + AG-UI SSE client + event reducer (no React)
- [x] `react/`: `useWisp()` + `<Panel/>`; built to a 202KB self-contained IIFE
  (`Wisp.mount(el, opts)`) via esbuild — no build step needed by the consumer
- [x] `server/`: AG-UI host with SSE endpoint; **mock** backend (scripted, dep-free)
  + **claude** backend wired (official adapter, bridged to async iterator)
- [x] POC demo (`examples/poc`): a "Notes" app with a ✨ slide-up wisp panel.
  **Verified in-browser end-to-end**: streaming text, tool-activity chips, live
  shared app-state sync (notes appear in the host app), and the approval gate
  (Go/Cancel → publish). No console errors.
- [x] **Real claude backend LIVE** (`notes-ai` app, `?ai=1` in the POC): Claude
  Agent SDK on Max-plan auth, official AG-UI adapter, real streaming +
  `ag_ui_update_state` shared-state sync verified in-browser and over curl
  (multi-turn memory incl. publish). ~7-18s per turn (haiku).
- [x] **Isolation by default** (backends/claude.js): `tools: []` strips every
  built-in SDK tool, `strictMcpConfig: true` + `settingSources: []` hide the
  machine's user MCP servers & settings. Verified adversarially — the agent
  reports exactly one tool (`ag_ui_update_state`) and cannot run bash. App
  configs override deliberately (e.g. book-builder adds its own mcpServers).
- [ ] Embed in book-builder (slide-up panel, ✨ button on every tab) over its `mcp.js`
- [ ] E2E: build a book by chatting (FAKE_IMAGES until OpenAI billing unblocked)

## Run the POC

```sh
cd ~/dev/wisp
npm install
npm run build      # bundle react/ → examples/poc/wisp.js
npm run poc        # host on http://127.0.0.1:4600
```

Open it, tap ✨, ask the copilot to "add buy milk", then "publish".

## Non-goals (v1)

- Multi-user/auth (single user on the tailnet, same as everything else)
- Voice, attachments, threads-within-a-session
- Polished theming system — one clean default skin, CSS variables for accent
