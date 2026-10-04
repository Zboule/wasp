#!/usr/bin/env bash
# Thin invoke helper: one turn, prints wall-clock latency + the response body.
#   ./deploy/40-invoke.sh "<prompt>" [session-id]
# Session id must be 33-256 chars (AgentCore constraint); we pad if needed.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh

PROMPT="${1:?usage: 40-invoke.sh <prompt> [session-id]}"
SID="${2:-$(python3 -c 'import uuid;print(uuid.uuid4().hex+uuid.uuid4().hex)')}"
ARN=$(cat "$STATE_DIR/runtime_arn")
OUT=$(mktemp)

python3 - "$ARN" "$SID" "$PROMPT" "$OUT" <<'PY'
import subprocess, sys, time, json, os
arn, sid, prompt, out = sys.argv[1:5]
payload = json.dumps({"prompt": prompt})
cmd = ["aws","bedrock-agentcore","invoke-agent-runtime",
       "--agent-runtime-arn",arn,"--runtime-session-id",sid,
       "--content-type","application/json","--accept","application/json",
       "--cli-binary-format","raw-in-base64-out","--payload",payload,
       "--region",os.environ["AWS_REGION"],"--profile",os.environ["AWS_PROFILE"], out]
t=time.time()
r=subprocess.run(cmd, capture_output=True, text=True)
dt=time.time()-t
if r.returncode!=0:
    print("INVOKE FAILED:", r.stderr[:500]); sys.exit(1)
body=open(out).read()
try: body=json.dumps(json.loads(body))[:800]
except Exception: body=body[:800]
print(f"latency_s={dt:.2f}")
print("session=", sid[:12])
print("body=", body)
PY
rm -f "$OUT"
