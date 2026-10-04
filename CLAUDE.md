# wasp: instructions for agents working on this repo

Wasp runs agent conversations on Amazon Bedrock AgentCore: threads, a queue
(`later` / `asap` / `now`), interrupt, a durable AG-UI feed, MCP as the caller.
Layout and status: `README.md`. Design: issue #2 and its sub-issues.

## ⚠️ SECURITY INVARIANTS: read before touching IAM, storage, credentials or the runner

**Threat model: the agent fully controls its microVM.** It runs with
`bypassPermissions` and a shell, so assume it can execute any command and read
anything the microVM holds. Every guarantee below must hold even then. A change
that only works if the agent behaves is not secure.

1. **One microVM = one thread.** The AgentCore session id is the thread id. Never
   serve two threads from one session or one microVM.
2. **The runtime's own role has no data access.** The AgentCore execution role
   may only pull its image (ECR) and write logs. Never grant it DynamoDB, S3,
   KMS, SSM, `sts:AssumeRole` or anything that reaches data. Whatever it holds,
   the agent holds.
3. **Data access comes only from thread-scoped credentials minted outside the
   microVM.** The waker (outside the sandbox) assumes the thread role with a
   session policy limited to:
   - DynamoDB items with partition key `T#<threadId>` (`dynamodb:LeadingKeys`)
   - S3 `sessions/<threadId>/*` and `payloads/<threadId>/*`
   - KMS decrypt only with encryption context `threadId = <threadId>`

   It passes them in the invoke payload, along with the Claude credential. Never
   widen that policy, and never let the microVM mint or refresh credentials
   itself. Refresh goes through the waker.
4. **Every key a runner reads or writes starts with its thread id**: DynamoDB
   `PK = T#<threadId>`, S3 `<kind>/<threadId>/…`. Any new storage must follow
   this, or rule 3 stops covering it.
5. **Caller tokens** (MCP as the user) are encrypted with KMS under encryption
   context `{ threadId }`. Only the runner decrypts them, at delivery, for that
   thread. They're deleted from the queue item on delivery, and never logged or
   written to the transcript, the feed, a prompt or the SDK's configuration (it
   only sees the localhost MCP proxy). The plaintext lives in the runner's memory
   only, as the credential of the **running turn**: a turn keeps the principal of
   the message that started it (an `asap` message of another principal waits for
   the next turn), and a message without a token clears it.
6. **The app's own data is never reachable from the microVM** except through the
   app's MCP server, as the calling user.
7. **Accepted risks** (by design, not bugs, see `docs/security-model.md`): a
   compromised agent can alter anything in its **own** thread (queue, feed,
   transcript), leak its own thread's data, read the caller token of the turn it
   is running (its user's, or the service account the app minted it for), and
   read the Claude credential. Prefer an API key with a spend limit, or Bedrock
   mode, over a long-lived subscription token.
8. **The boundary tests must stay green.** Today that is one unit test: the
   exact session policy (`packages/infra/src/waker/waker.test.ts`). The E2E
   escape test (the agent tries to read or write another thread, decrypt another
   thread's token, and use the runtime's own role, and every attempt must be
   denied) is **not built yet**: don't assume it covers you. Until it exists,
   verify a boundary change by hand against a deployed stack and say how. Any
   change to IAM, storage keys, credentials or the runner/agent boundary keeps
   these tests passing and updates `docs/security-model.md` in the same change.

## Conventions

- pnpm 11 workspaces (`packageManager` in `package.json`). TypeScript run with
  Node's type stripping (`.ts` imports, `erasableSyntaxOnly`).
- `pnpm typecheck && pnpm test` before every push. Public CI runs the same.
- The engine is tested through two seams: `ThreadStore` (in-memory for unit
  tests) and `Agent` (`scriptedAgent` mirrors the real SDK's behaviour, which
  was measured in issue #4). `packages/runner/scripts/smoke-sdk.ts` runs the
  same scenarios against the real model.
- Comments explain a non-obvious *why*, never what the next line does.
