#!/usr/bin/env bash
# Smoke test against a running container: health, then a JSON turn, then an SSE
# turn that resumes the same session.
set -euo pipefail
BASE="${BASE:-http://localhost:8080}"

echo "== GET /ping =="
curl -fsS "$BASE/ping"; echo

echo; echo "== POST /invocations (json) =="
RESP=$(curl -fsS -H 'accept: application/json' -H 'content-type: application/json' \
  -d '{"prompt":"In one short sentence, say hello and name the model you are."}' \
  "$BASE/invocations")
echo "$RESP"
SID=$(printf '%s' "$RESP" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
echo "session: ${SID:-<none>}"

echo; echo "== POST /invocations (sse, resume) =="
curl -fsS -N -H 'content-type: application/json' \
  -d "{\"prompt\":\"What did I just ask you?\",\"sessionId\":\"$SID\"}" \
  "$BASE/invocations"
echo
