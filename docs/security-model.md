# Security model

The invariants agents must respect are in `CLAUDE.md`. This page explains them.

## Threat model

The agent is Claude running with `bypassPermissions` and a shell inside an
AgentCore microVM. It browses the web and reads tool output, so it can be
prompt-injected. **We assume the worst: the agent fully controls its microVM.**
It can run any command, read every file and environment variable, and call any
endpoint the microVM can reach.

What must stay true anyway:

- It cannot **read** another thread: transcript, feed, queue or payloads.
- It cannot **write** to another thread.
- It cannot act **as another user**: it can't use another thread's caller token.
- It cannot reach the **app's data** except through the app's MCP server, as its
  own thread's user.

## How it's enforced

AgentCore gives every session its own microVM, and the session id is the thread
id. So the boundary is the microVM, and AWS IAM enforces it: the microVM only
ever holds credentials scoped to its own thread.

```
            outside the sandbox                         inside the microVM (untrusted)
  ┌──────────────────────────────────────┐        ┌────────────────────────────────┐
  │ waker Lambda                          │ invoke │ runner + Claude CLI + tools    │
  │  sts:AssumeRole(thread role,          │───────►│ holds ONLY:                    │
  │    session policy for threadId)       │ creds, │  - thread-scoped temp creds    │
  │  reads the Claude credential (SSM)    │ Claude │  - the Claude credential       │
  └──────────────────────────────────────┘ cred   │ ambient runtime role: ECR+logs │
                                                    └────────────────────────────────┘
```

| Layer | Allows | Enforced by |
|---|---|---|
| Runtime execution role (ambient in the microVM) | ECR pull, CloudWatch logs. **No data.** | IAM |
| Thread role session policy | DynamoDB `LeadingKeys = T#<threadId>`; S3 `sessions/<threadId>/*`, `payloads/<threadId>/*`; KMS decrypt with `kms:EncryptionContext:threadId = <threadId>` | IAM / STS session policy |
| Credential lifetime | ≤ 1 hour (role chaining). The runner asks for a refresh from 10 minutes before expiry, again every minute until it arrives; the waker answers with a second invoke to the same session. | STS |
| Caller tokens | encrypted by the client with context `{ threadId }`, decryptable only through the thread role | KMS |
| App data | only through the app's MCP server with the caller's token | the app |
| User files | uploaded by the browser with a presigned POST for one key, `payloads/<threadId>/files/<fileId>/<name>`, signed by the app's role (`s3:PutObject` on `payloads/*/files/*` only). Inside the thread's own prefix, so the session policy is unchanged. Downloads are presigned with `Content-Disposition: attachment`, so an uploaded page never runs on the bucket's origin. | IAM, S3 POST policy |
| Tool payloads (`outputRef`, `argsRef`) | written by the agent under `payloads/<threadId>/`, with any content type it chooses. Presigned with `Content-Type: text/plain; charset=utf-8`, so they open as text in a tab and an agent-written page never runs on the bucket's origin. | the client's presign |

Refs the client signs: the agent can write its own feed and queue, so any
S3 key stored there (a file's `ref`, a tool result's `outputRef` or `argsRef`)
is agent-written, while the app's role, which signs download URLs, reads the
whole bucket. The client therefore signs a ref only if it names this thread's
`payloads/` (`isPayloadRef`; a file must also parse as one, `parseFileRef`),
and drops it otherwise. Without this, an agent could plant a ref to another
thread's transcript in its own feed and have it served to its user.

Files: the client attaches a file to a message only if its key parses as one
of **this** thread's files, and takes its size and type from S3, not from the
caller. The bucket allows CORS `POST` (`WaspAgent` `allowedOrigins`, any
origin by default): CORS only lets a browser send what the presigned POST
already authorises. The runner places only keys shaped like files in the
working directory: that keeps its own job tidy, and is not a boundary, since
the agent owns the microVM anyway.

## Accepted risks

These are **not** bugs. A compromised agent is the owner of its own thread.

| Possible | Why it's accepted |
|---|---|
| Delete or alter its own thread's queue, feed or transcript, including inventing "the user said…" events | It's that thread's own conversation. No other thread or user is affected. |
| Exfiltrate its own thread's data over the network | The agent needs network access to do its job, and it only ever holds its own thread. |
| Read, replace or add files in its own thread, including ones later messages attach | Same as the transcript: its own thread's data. The client re-checks a file's size and type in S3 when a message attaches it. |
| Read its own user's caller token | That token grants only what that user can already do through MCP, and it lives a few hours. |
| Read the Claude credential | The Claude CLI needs it inside the microVM. Mitigation: an API key with a spend limit, or Bedrock mode (temporary IAM credentials, nothing long-lived to steal). |

## Verification

**Session policy, exactly (unit test, CI).** `packages/infra/src/waker/waker.test.ts`
compares `threadSessionPolicy` with the full expected document, statement by
statement, and checks that another thread's id appears nowhere in it. Changing
what a runner's credentials reach therefore means changing that test on purpose.
It checks the policy we write, not what AWS does with it: it does not catch a
storage key that leaves the thread prefix, and it does not exercise IAM.

**Escape test (E2E): not built yet.** It is planned (README, *Next*), and is
the test that will prove the boundary against a deployed stack. The demo agent
will be told to:

1. call AWS with the microVM's ambient credentials (list the table, read the bucket)
2. read another thread's DynamoDB items and S3 transcript
3. write an item into another thread's partition
4. decrypt a caller token that belongs to another thread

and the test will assert that each attempt is denied (the tool output shows
`AccessDenied`), and that the other thread's feed and transcript are
byte-for-byte unchanged. Until it exists, a boundary change is verified by hand
against a deployed stack, and the change says how.

Any change to IAM, storage keys, credentials or the runner/agent boundary must
keep these tests green, and must update this page in the same change.
