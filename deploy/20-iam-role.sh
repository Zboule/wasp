#!/usr/bin/env bash
# Create (or update) the AgentCore Runtime execution role: ECR pull, CloudWatch
# logs/metrics, X-Ray, Bedrock invoke (for AGENT_AUTH_MODE=bedrock), and the
# AgentCore workload-identity actions.
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/config.sh

TRUST=$(cat <<JSON
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
  "Action": "sts:AssumeRole",
  "Condition": {
    "StringEquals": { "aws:SourceAccount": "$ACCOUNT_ID" },
    "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:$AWS_REGION:$ACCOUNT_ID:*" }
  }
}]}
JSON
)

POLICY=$(cat <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "ECRAuth", "Effect": "Allow", "Action": ["ecr:GetAuthorizationToken"], "Resource": "*" },
  { "Sid": "ECRPull", "Effect": "Allow",
    "Action": ["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:BatchCheckLayerAvailability"],
    "Resource": "arn:aws:ecr:$AWS_REGION:$ACCOUNT_ID:repository/$REPO" },
  { "Sid": "Logs", "Effect": "Allow",
    "Action": ["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents","logs:DescribeLogStreams","logs:DescribeLogGroups"],
    "Resource": "arn:aws:logs:$AWS_REGION:$ACCOUNT_ID:log-group:/aws/bedrock-agentcore/*" },
  { "Sid": "Observability", "Effect": "Allow",
    "Action": ["xray:PutTraceSegments","xray:PutTelemetryRecords","xray:GetSamplingRules","xray:GetSamplingTargets","cloudwatch:PutMetricData"],
    "Resource": "*" },
  { "Sid": "Bedrock", "Effect": "Allow",
    "Action": ["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],
    "Resource": ["arn:aws:bedrock:*::foundation-model/anthropic.*","arn:aws:bedrock:*:$ACCOUNT_ID:inference-profile/*"] },
  { "Sid": "SessionStoreS3", "Effect": "Allow",
    "Action": ["s3:GetObject","s3:PutObject"],
    "Resource": "arn:aws:s3:::${AGENT_SESSIONSTORE_S3_BUCKET:-none}/*" },
  { "Sid": "WorkloadIdentity", "Effect": "Allow",
    "Action": ["bedrock-agentcore:GetWorkloadAccessToken","bedrock-agentcore:GetWorkloadAccessTokenForJWT","bedrock-agentcore:GetWorkloadAccessTokenForUserId"],
    "Resource": "*" },
  { "Sid": "SSMSecret", "Effect": "Allow",
    "Action": ["ssm:GetParameter"],
    "Resource": "arn:aws:ssm:$AWS_REGION:$ACCOUNT_ID:parameter$AGENT_SECRET_SSM_PARAM" },
  { "Sid": "KMSDecrypt", "Effect": "Allow",
    "Action": ["kms:Decrypt"],
    "Resource": "*",
    "Condition": { "StringEquals": { "kms:ViaService": "ssm.$AWS_REGION.amazonaws.com" } } }
]}
JSON
)

echo ">> create/update role $ROLE_NAME"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST"
else
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" >/dev/null
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "${ROLE_NAME}-policy" --policy-document "$POLICY"

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "$ROLE_ARN" > "$STATE_DIR/role_arn"
echo ">> role: $ROLE_ARN"
