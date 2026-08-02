# AgentCore Runtime requires ARM64. Build with:
#   docker build --platform linux/arm64 -t agent-runtime .
# (Buildx on an Apple-silicon Mac does this natively; on x86 CI use --platform.)
FROM --platform=linux/arm64 node:22-slim

# The Agent SDK bundles a native `claude` CLI binary for the host platform, so
# no separate Claude Code install is needed. It does shell out, so keep a shell
# and CA certs (outbound HTTPS to api.anthropic.com).
# curl is here for the agent, not the runtime: a service that hands the agent
# presigned URLs for a user's uploads needs SOME way to pull them into the
# working directory before Read or a script can touch them.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root. The CLI writes cache/config under HOME, so give it a writable home.
RUN useradd --create-home --uid 10001 app
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
# Optional per-service config baked in (or mount / set AGENT_CONFIG_FILE at run).
COPY agent.config.json* ./

# Writable dirs for per-session config + working directories (see agent.mjs).
RUN mkdir -p /home/app/.claude /work && chown -R app:app /home/app /work /app
USER app
ENV HOME=/home/app \
    CLAUDE_CONFIG_DIR=/home/app/.claude \
    PORT=8080 \
    NODE_ENV=production

EXPOSE 8080
CMD ["node", "src/server.mjs"]
