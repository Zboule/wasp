#!/usr/bin/env bash
# Create (or update) the AgentCore Runtime from the pushed image. HTTP protocol,
# PUBLIC network (managed egress so the agent can reach Bedrock), Bedrock auth.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh

ROLE_ARN=$(cat "$STATE_DIR/role_arn")
CONTAINER_URI="${ECR_URI}:${IMAGE_TAG}"

ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"$CONTAINER_URI\"}}"
NETWORK='{"networkMode":"PUBLIC"}'
PROTOCOL='{"serverProtocol":"HTTP"}'
ENVVARS="{\"AGENT_AUTH_MODE\":\"$AGENT_AUTH_MODE\",\"AGENT_MODEL\":\"$AGENT_MODEL\",\"AGENT_SECRET_SSM_PARAM\":\"$AGENT_SECRET_SSM_PARAM\",\"AWS_REGION\":\"$AWS_REGION\",\"AGENT_CONFIG_FILE\":\"/app/agent.config.json\"}"

EXISTING=$(aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text 2>/dev/null || echo None)

if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
  echo ">> updating existing runtime $EXISTING"
  aws bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "$EXISTING" \
    --agent-runtime-artifact "$ARTIFACT" \
    --network-configuration "$NETWORK" \
    --protocol-configuration "$PROTOCOL" \
    --role-arn "$ROLE_ARN" \
    --environment-variables "$ENVVARS" >"$STATE_DIR/runtime.json"
else
  echo ">> creating runtime $RUNTIME_NAME"
  aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "$RUNTIME_NAME" \
    --agent-runtime-artifact "$ARTIFACT" \
    --network-configuration "$NETWORK" \
    --protocol-configuration "$PROTOCOL" \
    --role-arn "$ROLE_ARN" \
    --environment-variables "$ENVVARS" >"$STATE_DIR/runtime.json"
fi

ARN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("agentRuntimeArn",""))' "$STATE_DIR/runtime.json")
echo "$ARN" > "$STATE_DIR/runtime_arn"
echo ">> runtime ARN: $ARN"
cat "$STATE_DIR/runtime.json"
