# wasp-backend

A reusable **Claude Agent SDK** runtime that runs on **Amazon Bedrock
AgentCore Runtime**. Build the image once, instantiate it per service
(TopTopTime, petitsonge, ...) in its own account/stack with its own config.

Why AgentCore: it's serverless (idle cost ~$0), gives each session its own
Firecracker microVM (isolation + fast cold start), auto-scales to hundreds of
concurrent sessions, and bills per-second with CPU charged only while the agent
is actually working. It removes the reasons Lambda is a bad host for Claude Code
(15-min cap, no persistent subprocess) while keeping scale-to-zero economics.

The image is a plain container implementing the AgentCore contract, so the same
artifact also runs locally, on Fargate, or on EC2.

## The catch this repo solves: swappable auth

One image, three auth modes, chosen by `AGENT_AUTH_MODE`:

| Mode | Auth | Billing | Use |
|---|---|---|---|
| `max` | `CLAUDE_CODE_OAUTH_TOKEN` (or host's saved `claude login`) | Your Max/Pro subscription | **dev only** |
| `apikey` | `ANTHROPIC_API_KEY` | Anthropic API, pay-as-you-go | prod |
| `bedrock` | AWS IAM (the runtime's execution role) | On the AWS invoice | prod, AWS-native, **no secrets** |

The SDK's credential precedence is `Bedrock/Vertex > ANTHROPIC_AUTH_TOKEN >
ANTHROPIC_API_KEY > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN > saved login`, so
`max` mode actively **unsets** anything above the token, or the subprocess
silently switches to API billing. See `src/auth.mjs`.

**This deployment runs in `max` mode** (your Max subscription), verified live on
AgentCore (see `docs/RESULTS.md`). The `CLAUDE_CODE_OAUTH_TOKEN` lives in a **free
SSM Parameter Store SecureString** (`/wasp-backend/agent-secrets`); the container
fetches it at boot via `src/secrets.mjs`, so the token never sits in the runtime
config. (Bedrock mode also works but this account hasn't completed Bedrock model
access, so we used the subscription.) Getting a headless Max token:

```sh
./scripts/mint-max-token.sh          # runs `claude setup-token`, prints a ~1yr token
export CLAUDE_CODE_OAUTH_TOKEN=<paste>
AGENT_AUTH_MODE=max AGENT_WORK_DIR=./.work node src/server.mjs
```

## The container contract (AgentCore Runtime, `serverProtocol: HTTP`)

- `0.0.0.0:8080`, **ARM64** image
- `GET /ping` -> `{"status":"Healthy"}` (or `"HealthyBusy"` while a turn runs)
- `POST /invocations` -> one agent turn, streams **SSE** (`Accept: application/json`
  for a single JSON blob)
- AgentCore sets `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`; we key the
  conversation off it. Locally, pass `sessionId` in the body.

## Deploy to AgentCore

All infra is in the `perso` account, `us-east-1`. Scripts are idempotent.

```sh
# one-time: store the subscription token in a free SSM SecureString
aws ssm put-parameter --name /wasp-backend/agent-secrets --type SecureString \
  --value '{"CLAUDE_CODE_OAUTH_TOKEN":"sk-ant-oat01-..."}' --overwrite

bash deploy/20-iam-role.sh       # execution role: ECR pull, logs, Bedrock, SSM+KMS
bash deploy/10-push-ecr.sh       # build linux/arm64, push to ECR
bash deploy/30-create-runtime.sh # create/update the AgentCore runtime
python3 deploy/measure.py        # wait READY, measure cold start, verify resume
```

Token rotation: update the SSM value, then re-run `deploy/30-create-runtime.sh`
to recycle warm microVMs (they cache the token from their one-time boot-load).

See `docs/DEPLOY.md` for the full walkthrough and `docs/RESULTS.md` for measured
cold-start latency and the session-resume verification from the live runtime.

## Sessions & persistence

Within a session AgentCore keeps the same microVM, so we hold the caller-id ->
SDK-session-id map in memory and `resume` the SDK session each turn (two distinct
ids: the caller's stable id keys the working dir where transcripts live; the SDK
mints its own id for `resume`). Across a microVM restart that map and the
transcript are gone; for conversations that must survive that, attach a
[`SessionStore`](https://code.claude.com/docs/en/agent-sdk/session-storage)
adapter (S3/Redis/Postgres) at the `sdkSessionFor` map in `src/server.mjs`.

## Files

| Path | Role |
|---|---|
| `src/server.mjs` | AgentCore contract (`/ping`, `/invocations`), caller->SDK session map |
| `src/agent.mjs` | one Agent SDK turn per call, resume, isolation |
| `src/auth.mjs` | resolves `max` / `apikey` / `bedrock`, fixes env precedence |
| `src/config.mjs` | per-service agent config resolution |
| `Dockerfile` | ARM64 image |
| `deploy/` | ECR push, IAM role, runtime create, latency+resume measurement |
| `scripts/` | `mint-max-token.sh`, `run-local.sh`, `smoke.sh` |
