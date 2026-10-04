#!/usr/bin/env bash
# Run the runtime locally in Docker. Defaults to Max-plan (dev) auth.
#
#   AGENT_AUTH_MODE=max     CLAUDE_CODE_OAUTH_TOKEN=...  ./scripts/run-local.sh
#   AGENT_AUTH_MODE=apikey  ANTHROPIC_API_KEY=...        ./scripts/run-local.sh
#
# Then in another shell:  ./scripts/smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${AGENT_AUTH_MODE:-max}"
IMAGE="${IMAGE:-agent-runtime}"

echo "Building ${IMAGE} (linux/arm64)..."
docker build --platform linux/arm64 -t "$IMAGE" .

ARGS=(-p 8080:8080 -e "AGENT_AUTH_MODE=$MODE")
case "$MODE" in
  max)
    : "${CLAUDE_CODE_OAUTH_TOKEN:?set CLAUDE_CODE_OAUTH_TOKEN (run scripts/mint-max-token.sh)}"
    ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
    ;;
  apikey)
    : "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
    ARGS+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
    ;;
  bedrock)
    ARGS+=(-e CLAUDE_CODE_USE_BEDROCK=1 -e "AWS_REGION=${AWS_REGION:-us-east-1}")
    # Mount local AWS creds for a quick test; in prod use an IAM task role.
    [ -d "$HOME/.aws" ] && ARGS+=(-v "$HOME/.aws:/home/app/.aws:ro")
    ;;
  *) echo "unknown AGENT_AUTH_MODE=$MODE" >&2; exit 1 ;;
esac

[ -f agent.config.json ] && ARGS+=(-e AGENT_CONFIG_FILE=/app/agent.config.json)

echo "Running in '$MODE' mode on :8080 ..."
exec docker run --rm "${ARGS[@]}" "$IMAGE"
