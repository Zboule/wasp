# The wasp runner. Build for linux/arm64 (AgentCore's architecture).
# The context holds runner.mjs (the bundled engine) and package.json with its
# lockfile (the Agent SDK, installed here because it ships a per-platform
# `claude` binary).
# Pinned to the multi-arch index digest: this image runs next to the thread's
# credentials, so what it contains must not change between two deploys of the
# same release. Bump it on purpose (`docker buildx imagetools inspect node:24-slim`).
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# base: what a shell-using agent reaches for first. browser: + Chromium.
ARG FLAVOR=base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq unzip python3 \
    && if [ "$FLAVOR" = "browser" ]; then \
         apt-get install -y --no-install-recommends chromium fonts-liberation \
         && npm install -g --no-audit --no-fund playwright-core@1.63.0; \
       fi \
    && rm -rf /var/lib/apt/lists/* && npm cache clean --force

RUN useradd --create-home --uid 10001 wasp && mkdir -p /work && chown wasp:wasp /work
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY runner.mjs ./
COPY definition/ /app/definition/

USER wasp
ENV HOME=/home/wasp \
    PORT=8080 \
    NODE_ENV=production \
    WASP_WORK_DIR=/work \
    CHROME_PATH=/usr/bin/chromium \
    NODE_PATH=/usr/local/lib/node_modules
EXPOSE 8080
CMD ["node", "runner.mjs"]
