# The wasp runner. Build for linux/arm64 (AgentCore's architecture).
# The context holds runner.mjs (the bundled engine) and package.json (the Agent
# SDK, installed here because it ships a per-platform `claude` binary).
FROM node:24-slim

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
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
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
