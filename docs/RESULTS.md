# Live AgentCore results (perso, us-east-1)

Runtime: `wasp_backend-EPVH8A5x4r`
ECR image: `<account-id>.dkr.ecr.us-east-1.amazonaws.com/wasp-backend:latest` (ARM64, ~387 MB)
Date: 2026-07-26

## What is verified working

- ARM64 image builds and pushes to ECR.
- `create-agent-runtime` (HTTP protocol, PUBLIC network) reaches **READY** in ~1 minute.
- The container boots on AgentCore: logs show the resolved auth mode and
  `agent-runtime listening on 0.0.0.0:8080`.
- `invoke-agent-runtime` reaches `POST /invocations`; the server runs the Agent
  SDK and returns. The full request path works end to end.

## Cold start (measured, bedrock attempt)

Measured with a trivial prompt via `invoke-agent-runtime`:

| Invoke | Wall-clock |
|---|---|
| First invoke (cold microVM) | **13.8 s** |
| Same session, second invoke (warm microVM) | **2.95 s** |
| Second fresh session (cold) | **13.6 s** |
| **Startup overhead (cold - warm)** | **~10.9 s** |

The ~10.9 s cold-minus-warm delta isolates microVM provisioning + Node/SDK
process init from per-turn work (both invokes ran the identical operation). It is
higher than AWS's advertised 2-5 s and points at image/init weight to trim (slim
base, fewer layers, lazy init).

## Bedrock model access blocker (not a container problem)

In `bedrock` mode, turns failed with "The model us.anthropic.claude-sonnet-4-6 is
not available on your bedrock deployment." Reproduced locally with the `perso`
Administrator profile (full Bedrock permissions), so it is **not** an
execution-role gap: the account has not completed the Anthropic model-access /
use-case agreement in Bedrock. (Raw `InvokeModel` on 4-6 succeeds, but Claude
Code's availability pre-check rejects it; 4-5 / 4-20250514 / Haiku all report no
access.) Switching auth off Bedrock sidesteps this entirely.

<!-- MAX-MODE RESULTS APPENDED BELOW AFTER THE RUN -->

## Subscription (max) auth via free SSM SecureString — mechanism VERIFIED

Reconfigured the runtime to `AGENT_AUTH_MODE=max`, reading the token from an SSM
Parameter Store **SecureString** (Standard tier, free) named
`/wasp-backend/agent-secrets` (JSON `{"CLAUDE_CODE_OAUTH_TOKEN":"..."}`). The
execution role was granted `ssm:GetParameter` + `kms:Decrypt`.

CloudWatch confirms the full path works on AgentCore:
- `secrets: loaded CLAUDE_CODE_OAUTH_TOKEN from SSM`
- `auth: mode=max — subscription (Max/Pro plan)`
- invoke reaches the agent and attempts the model call

The turn then fails with `401 Invalid bearer token` because the token value
supplied for this test is not a valid Claude Code OAuth token (it lacks the
`sk-ant-oat...` prefix). This is a bad-credential, not a wiring problem: the
container fetched it from SSM and used it exactly as designed.

Cold start (max build): first invoke **15.2 s**, warm **3.7 s**, startup
overhead **~11.5 s** (consistent with the bedrock build).

### To complete the working-turn + resume proof
1. `claude setup-token` (interactive; yields an `sk-ant-oat...` token, ~1yr).
2. `aws ssm put-parameter --name /wasp-backend/agent-secrets --type SecureString --overwrite --value '{"CLAUDE_CODE_OAUTH_TOKEN":"<token>"}'`
3. `python3 deploy/measure.py` — new sessions spin fresh microVMs that re-fetch
   the token; no image rebuild or runtime update needed.

Session resume itself was already verified locally on the subscription (codeword
recalled across two turns); step 3 repeats it on AgentCore.

## FINAL: working end to end on the subscription (verified)

After putting a real `sk-ant-oat...` token in the SSM SecureString and bumping
the runtime version (to recycle warm microVMs, which cache the token from their
one-time boot-load), the full flow passed live on AgentCore:

| Metric | Value |
|---|---|
| Cold start (first invoke, fresh microVM) | **15.4 s** |
| Warm invoke (same session) | **4.1 s** |
| Second cold sample (new session) | 12.9 s |
| Startup overhead (cold - warm) | **~11.2 s** |
| Session resume | **PASS** (turn 1 stored `ZEBRA-42`, turn 2 recalled it) |
| Auth | Max subscription, token from free SSM SecureString |

### Operational note: token rotation
`loadSecrets` runs once at process boot, and AgentCore reuses a warm microVM
across sessions, so updating the SSM value does NOT affect already-running
processes. To roll a token: update the SSM param, then either bump the runtime
version (`deploy/30-create-runtime.sh`) to recycle the fleet, or wait for the
idle timeout to retire warm microVMs.

### Cold start is high (~11 s) vs AWS's advertised 2-5 s
Trim candidates: slimmer base image (distroless/alpine), fewer/smaller npm deps
(the AWS SDK adds weight), and deferring SDK/subprocess init. Not optimized here.
