# Deploying wasp-backend to Amazon Bedrock AgentCore

Target: the `perso` account (`<account-id>`), region `us-east-1` (an AgentCore
high-limit region: 1,000 concurrent sessions). Auth mode: `max` (the Max
subscription), with the token in a free SSM Parameter Store SecureString that the
container fetches at boot. (`bedrock` mode also works but this account hasn't
completed Bedrock model access; see `docs/RESULTS.md`.)

## Prerequisites

- AWS CLI v2 with the `perso` profile and working credentials
- Docker with buildx (Apple silicon builds `linux/arm64` natively)
- A Claude Code OAuth token (`claude setup-token`, an `sk-ant-oat...` string)
  stored in an SSM SecureString (step 0)

## Steps

Everything is captured in idempotent scripts under `deploy/`. `deploy/config.sh`
holds the shared variables (account, region, repo, runtime name, model).

### 0. Store the subscription token (free SSM SecureString)

```sh
aws ssm put-parameter --name /wasp-backend/agent-secrets --type SecureString \
  --value '{"CLAUDE_CODE_OAUTH_TOKEN":"sk-ant-oat01-..."}' --overwrite
```

Standard-tier SecureString has no per-parameter charge. The value is a JSON map
of env vars to inject; use `ANTHROPIC_API_KEY` instead for `apikey` mode.

### 1. Execution role

```sh
bash deploy/20-iam-role.sh
```

Creates `wasp-backend-agentcore-exec` with:
- a trust policy for `bedrock-agentcore.amazonaws.com` scoped to this account/region
- ECR pull on the `wasp-backend` repo
- CloudWatch Logs + metrics + X-Ray
- `bedrock:InvokeModel*` on Anthropic foundation models and inference profiles
- the AgentCore workload-identity actions

The role ARN is written to `deploy/.state/role_arn`.

### 2. Build and push the image

```sh
bash deploy/10-push-ecr.sh
```

Creates the ECR repo if needed, logs in, then `docker buildx build --platform
linux/arm64 --push`. ARM64 is mandatory for AgentCore.

### 3. Create the runtime

```sh
bash deploy/30-create-runtime.sh
```

Calls `bedrock-agentcore-control create-agent-runtime` (or `update-...` if it
exists) with:
- `containerConfiguration.containerUri` = the pushed image
- `networkConfiguration.networkMode = PUBLIC` (managed egress to Bedrock)
- `protocolConfiguration.serverProtocol = HTTP` (our `/invocations` + `/ping`)
- `environmentVariables`: `AGENT_AUTH_MODE=max`, `AGENT_MODEL=claude-sonnet-5`,
  `AGENT_SECRET_SSM_PARAM=/wasp-backend/agent-secrets`, `AWS_REGION=us-east-1`,
  `AGENT_CONFIG_FILE=/app/agent.config.json`

The runtime ARN is written to `deploy/.state/runtime_arn`.

### 4. Verify

```sh
python3 deploy/measure.py          # waits READY, measures latency, checks resume
./deploy/40-invoke.sh "Say hi in one sentence."   # ad-hoc single turn
```

Invocation uses `bedrock-agentcore invoke-agent-runtime` with
`--runtime-session-id` (33-256 chars; that value becomes the
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header the server reads).

Measured results are recorded in `docs/RESULTS.md`.

**Token rotation:** `loadSecrets` runs once per process at boot and AgentCore
reuses warm microVMs across sessions, so updating the SSM value does not affect
running processes. After updating the param, re-run `deploy/30-create-runtime.sh`
to bump the runtime version and recycle the fleet (or wait for the idle timeout).

## Wiring your existing Lambda API

The product API (already on Lambda) stays the front door. To hand a request to
the agent, the Lambda calls `bedrock-agentcore:InvokeAgentRuntime` with a stable
`runtime-session-id` (e.g. your conversation id), streams the SSE back to the
client, and reuses the same session id on follow-up turns. The Lambda's role
needs `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN.

## Switching auth for production

`bedrock` mode needs no secrets and is the default here. To run on the Anthropic
API instead, set `AGENT_AUTH_MODE=apikey` and inject `ANTHROPIC_API_KEY` from
Secrets Manager (add a `secrets`/env reference in `30-create-runtime.sh`). To run
a dev instance on your Max plan, set `AGENT_AUTH_MODE=max` and inject
`CLAUDE_CODE_OAUTH_TOKEN` (from `scripts/mint-max-token.sh`).

## Teardown

```sh
source deploy/config.sh
aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "$(basename "$(cat deploy/.state/runtime_arn)")"
aws ecr delete-repository --repository-name wasp-backend --force
aws iam delete-role-policy --role-name wasp-backend-agentcore-exec --policy-name wasp-backend-agentcore-exec-policy
aws iam delete-role --role-name wasp-backend-agentcore-exec
```
