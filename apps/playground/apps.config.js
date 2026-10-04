// App registry: each key is an "app" the host can serve a chat for. A wisp client
// hits POST /agent/<key>/run. Backend + agent config live here — this is the
// per-app glue that makes wisp reusable across products.
export const registry = {
  // Scripted demo — instant, free, no model. Good for UI dev and plumbing tests.
  notes: {
    backend: "mock",
    title: "Notes Copilot",
  },

  // The same notes app driven by a REAL agent (Claude Agent SDK, Max-plan auth).
  "notes-ai": {
    backend: "claude",
    agentId: "notes-ai",
    model: "claude-haiku-4-5",
    initialState: { notes: [], published: false },
    // Embedded copilots get NO machine access: tools: [] strips every built-in
    // SDK tool (Bash, Read, Write, …) from the model's context. The only tool
    // left is the adapter's ag_ui_update_state MCP tool.
    tools: [],
    systemPrompt: [
      "You are the Notes Copilot, a tiny assistant embedded in a notes app via a chat panel.",
      "Shared state shape: { notes: string[], published: boolean }. The current state is provided to you.",
      "To change the app, call the ag_ui_update_state tool. Updates replace whole keys, so when",
      "adding or removing a note, always send the FULL notes array (existing notes plus the change).",
      "When the user asks to publish, confirm in one short sentence, then set published: true.",
      "Never invent notes the user didn't ask for. Keep replies to one or two short sentences.",
    ].join(" "),
  },

  // How book-builder will plug in (real agent over its MCP):
  // book: {
  //   backend: "claude",
  //   agentId: "book-author",
  //   model: "claude-fable-5",
  //   systemPrompt: BOOK_AUTHOR_PROMPT,           // storytelling + pipeline craft
  //   mcpServers: { "book-builder": { command: "node", args: ["../book-builder/mcp.js"],
  //                                   env: { BOOK_BUILDER_URL: "http://127.0.0.1:4507" } } },
  // },
};
