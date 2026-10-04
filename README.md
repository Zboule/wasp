# wasp

An engine for agent conversations on Amazon Bedrock AgentCore: threads, a message
queue (`later` / `asap` / `now`), interrupt, a durable feed of AG-UI events, and MCP
access as the calling user. An app adds one infra component and calls one client;
it keeps its users, its authorization, its MCP server and its agent definition.

> **v2 is under construction on this branch** (see the design in issue #2).
> The engine that apps run today is **v1**: tag `v1`, docs in `docs/v1/`.

**Security:** the agent is assumed to fully control its microVM, and isolation is per
thread. Read the invariants in `CLAUDE.md` (also `AGENTS.md`) before touching IAM,
storage, credentials or the runner. The reasoning is in `docs/security-model.md`.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | The contracts: AG-UI + wasp events, the feed and queue types, the `wasp.config.json` schema |
| `packages/runner` | The engine image: drain loop, queue, interrupt, MCP, storage |
| `packages/client` | What an app's API calls: post, feed, interrupt, cancel, deleteThread |
| `packages/infra` | `WaspAgent`, the SST component that deploys it all into the app's account |
| `packages/ui` | The chat UI (formerly wisp): headless core + React |
| `apps/demo` | A complete SST app: the end-to-end test target and the reference integration |
| `apps/playground` | Local host for UI work, with a mock model |

`packages/runner/legacy` holds the v1 engine while it is ported, and goes away
before v2 ships.
