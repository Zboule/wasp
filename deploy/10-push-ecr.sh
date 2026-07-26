#!/usr/bin/env bash
# Build the ARM64 image and push it to ECR.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh

echo ">> ensure ECR repo $REPO"
aws ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" \
       --image-scanning-configuration scanOnPush=true >/dev/null

echo ">> docker login to ECR"
# Use an isolated DOCKER_CONFIG with no credsStore. The host's cred helper
# (osxkeychain / "desktop") blocks on a keychain prompt in a background job and
# hangs the login; a fresh config dir stores the token as a plain file instead.
# Symlink the real cli-plugins so `docker buildx` is still discoverable.
export DOCKER_CONFIG="$(mktemp -d)"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
[ -d "$HOME/.docker/cli-plugins" ] && ln -s "$HOME/.docker/cli-plugins" "$DOCKER_CONFIG/cli-plugins"
aws ecr get-login-password | docker login --username AWS --password-stdin \
  "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo ">> build linux/arm64 and push (buildx, single arch)"
docker buildx build --platform linux/arm64 \
  -t "${ECR_URI}:${IMAGE_TAG}" --push .

echo ">> pushed ${ECR_URI}:${IMAGE_TAG}"
aws ecr describe-images --repository-name "$REPO" \
  --query 'sort_by(imageDetails,&imagePushedAt)[-1].{digest:imageDigest,pushed:imagePushedAt}' --output table
