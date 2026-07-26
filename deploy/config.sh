# Shared deploy config. `source` this from the numbered scripts.
# Everything lives in the `perso` account, us-east-1 (an AgentCore high-limit region).
export AWS_PROFILE="${AWS_PROFILE:-perso}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"

export REPO="wasp-backend"                       # ECR repo name
export IMAGE_TAG="${IMAGE_TAG:-latest}"
export ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO}"

export RUNTIME_NAME="wasp_backend"               # AgentCore runtime name (no dashes allowed)
export ROLE_NAME="wasp-backend-agentcore-exec"

# Auth: subscription (max) via a token in SSM (free SecureString). The model
# is an Anthropic API id the subscription can reach.
export AGENT_AUTH_MODE="${AGENT_AUTH_MODE:-max}"
export AGENT_MODEL="${AGENT_MODEL:-claude-sonnet-5}"
export AGENT_SECRET_SSM_PARAM="${AGENT_SECRET_SSM_PARAM:-/wasp-backend/agent-secrets}"

# Where we stash created ARNs between steps.
export STATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.state"
mkdir -p "$STATE_DIR"
