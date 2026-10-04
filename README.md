<p align="center">
  <img src="docs/assets/logo.svg" width="112" alt="wasp" />
</p>

<h1 align="center">wasp</h1>

<p align="center">
  <b>Agent conversations on Amazon Bedrock AgentCore, as a library.</b><br/>
  Threads, a real message queue, interrupt, a durable live feed, and a per-thread security boundary,<br/>
  for any app that wants a Claude agent working inside its own AWS account.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@zboule/wasp-client"><img alt="npm" src="https://img.shields.io/npm/v/@zboule/wasp-client?color=f5a524&label=npm"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-1d1b19"></a>
  <img alt="status" src="https://img.shields.io/badge/status-experimental%200.x-f5a524">
</p>

---

You bring an app with users. wasp brings the agent: a [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview)
runtime in a sandboxed microVM, the storage that keeps every conversation, and the plumbing that lets
people talk to it while it works.

```ts
// sst.config.ts: one component deploys the whole agent into your account
const agent = new WaspAgent('Agent', { definition: 'agent/', flavor: 'browser', claudeCredentialsParameter: '/my-app/claude' });
new sst.aws.Function('Api', { handler: 'src/api.handler', link: [agent] });
```

```ts
// your API: you check the user, wasp runs the agent
const wasp = createWaspClient(Resource.Agent);
await wasp.post(threadId, { text: 'Summarise our last 10 support tickets', deliver: 'later' });
const page = await wasp.feed(threadId, { after: cursor }); // { state, queue, entries, cursor }
```

```tsx
// your UI: a chat that already knows queues, tools and interrupts
<WaspChat transport={httpTransport(`/api/threads/${threadId}`)} />
```

## Why

Putting an agent in a product is mostly not about the model. It is about what happens around it:

- **People talk while the agent works.** wasp has a real queue. A message can wait for the turn to end
  (`later`), slip into the running turn at its next tool call (`asap`), or interrupt it (`now`).
- **Agents are slow, browsers are not patient.** Every turn streams into a durable feed of
  [AG-UI](https://docs.ag-ui.com) events. Reload the page, deploy, lose the connection: the feed is still
  there, with the queue next to it.
- **Sandboxes forget.** AgentCore recycles microVMs. wasp keeps each conversation's transcript in S3, so any
  microVM resumes any thread where it stopped.
- **An agent with a shell is a hostile tenant.** wasp assumes it controls its microVM, and makes sure it
  can still only ever reach its own thread. See [Security](#security).

## How it works

```
 Browser ──► your API ──► @zboule/wasp-client ──► DynamoDB (queue, feed) ──stream──► waker ──► AgentCore microVM
   ▲             │ checks the user                                              mints per-thread     │ Claude Agent SDK
   │             │                                                              credentials          │ + shell, browser
   └── polls the feed ◄───────────────────────────────── feed events, transcript (S3) ◄────────────────┘
```

1. Your API posts a message for a thread. It lands in that thread's queue.
2. The table's stream wakes the **waker**, a small Lambda outside the sandbox. It mints temporary credentials
   that reach **only that thread**, and invokes the AgentCore runtime with the thread id as its session.
3. The **runner** in the microVM takes a lease on the thread and drains its queue: each message becomes a turn
   of the Claude Agent SDK, resumed from the thread's transcript. `asap` messages join the running turn,
   `now` interrupts it.
4. What the agent says and does is written to the feed as it happens. Your UI polls it through your API.

## Packages

| Package | Runs in | What it is |
|---|---|---|
| [`@zboule/wasp-infra`](packages/infra) | `sst deploy` | `WaspAgent`: the runtime, its image, storage, KMS key, waker and IAM, in your account |
| [`@zboule/wasp-client`](packages/client) | your API | `post`, `feed`, `interrupt`, `cancel`, `deleteThread` |
| [`@zboule/wasp-ui`](packages/ui) | the browser | a headless session (any framework), `WaspChat` for React, and a one-file embed |
| [`@zboule/wasp-protocol`](packages/protocol) | everywhere | the shared contracts: feed events, queue, thread state, the store interface |

## Quick start

Requirements: an AWS account where Bedrock AgentCore is available, [SST v3](https://sst.dev), Docker
(the agent image is built for `linux/arm64` at deploy time), and a Claude credential.

```sh
npm i @zboule/wasp-infra @zboule/wasp-client @zboule/wasp-ui
aws ssm put-parameter --name /my-app/claude --type SecureString \
  --value '{"CLAUDE_CODE_OAUTH_TOKEN":"…"}'   # or {"ANTHROPIC_API_KEY":"…"}
```

`sst.config.ts` must list the providers `WaspAgent` builds with:

```ts
providers: {
  aws: { region: 'eu-west-1' },
  'aws-native': { version: '1.72.0', region: 'eu-west-1' },
  'docker-build': '0.0.14',
  time: '0.1.1'
}
```

Your agent is a folder: `agent/prompt.md` is appended to the Claude Code system prompt.

Then expose four routes per thread from your API (check that the user owns the thread first), and point the UI
at them:

```
GET    /threads/:id/feed?after=     → wasp.feed(id, { after })
POST   /threads/:id/messages        → wasp.post(id, { text, deliver })
POST   /threads/:id/interrupt       → wasp.interrupt(id)
DELETE /threads/:id/queue/:message  → wasp.cancel(id, message)
```

## Security

**Threat model: the agent fully controls its microVM.** It runs with every tool and no permission
prompts. wasp's guarantees hold anyway, and IAM enforces them:

- One microVM serves one thread.
- The runtime's own role can pull its image and write logs. That is all.
- Data access comes only from credentials the waker mints **outside** the sandbox, scoped to one thread:
  its DynamoDB partition, its S3 prefixes, and its caller tokens (KMS encryption context).
- Your app's own data is never reachable from the sandbox.

Accepted by design: an agent can do anything to **its own** thread, and can read the Claude credential it
runs with. The full model is in [`docs/security-model.md`](docs/security-model.md), and the invariants
contributors must keep are in [`CLAUDE.md`](CLAUDE.md).

## Status and roadmap

wasp is **experimental (0.x)**: it runs end to end in a private demo, and its API may still move.

Done: queue with `later` / `asap` / `now`, interrupt, durable AG-UI feed with cursor paging, transcript
persistence and resume, per-thread credentials, large-output offload to S3, credential refresh, self-healing
wake-ups, React chat and embed.

Next:
- MCP servers called **as the user** (caller tokens are already stored encrypted per message; the runner wiring is next)
- `wasp.config.json` for model, tools and MCP servers alongside `prompt.md`
- Live nudges (AppSync Events) on top of polling
- A scheduled sweep for stalled threads nobody is watching
- The escape test: an end-to-end suite where the agent tries to break out, and fails

## Development

```sh
pnpm install
pnpm typecheck && pnpm test
docker compose -f docker-compose.test.yml up -d      # DynamoDB Local + an S3 mock
WASP_DYNAMODB_ENDPOINT=http://localhost:8000 WASP_S3_ENDPOINT=http://localhost:9090 pnpm test
```

`packages/runner/scripts/` has smoke tests that run the real engine and image against the real model.

## Releasing

Bump the four published packages to the same version, then push a tag `vX.Y.Z`. The
[`release`](.github/workflows/release.yml) workflow checks the tag against the versions, runs the
typecheck and tests, builds, and publishes to npm with provenance through trusted publishing
(GitHub OIDC, no token).

## License

[MIT](LICENSE)
