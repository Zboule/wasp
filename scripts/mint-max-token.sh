#!/usr/bin/env bash
# Mint a Max/Pro-plan OAuth token for headless/dev use.
#
# Run this ON YOUR MACHINE (it opens a browser). It prints a token valid for
# ~1 year. It is NOT saved anywhere automatically — copy it and hand it to the
# container as CLAUDE_CODE_OAUTH_TOKEN (locally via -e, in AWS via Secrets
# Manager). Requires the `claude` CLI and an active Pro/Max/Team/Enterprise plan.
#
# NOTE: this token draws on your personal subscription. Use it for DEV only.
# For shared production, switch AGENT_AUTH_MODE=apikey (ANTHROPIC_API_KEY) or
# =bedrock — Anthropic recommends an API key for shared automation.
set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "The 'claude' CLI is not installed. Install Claude Code first." >&2
  exit 1
fi

echo "Opening the subscription auth flow. Copy the printed token." >&2
claude setup-token
