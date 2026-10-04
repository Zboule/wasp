// Load secrets from AWS SSM Parameter Store (SecureString) at startup.
//
// Parameter Store Standard-tier SecureString is FREE (no per-secret monthly
// charge, unlike Secrets Manager) and KMS-encrypted with the AWS-managed key.
// Set AGENT_SECRET_SSM_PARAM to the name of a SecureString whose value is a JSON
// object of env vars to inject, e.g. {"CLAUDE_CODE_OAUTH_TOKEN":"..."} for max
// mode or {"ANTHROPIC_API_KEY":"..."} for apikey mode. The runtime's IAM role
// needs ssm:GetParameter (+ kms:Decrypt for the key) on that parameter.
//
// Returns the list of env-var NAMES loaded (never the values) for logging.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

export async function loadSecrets(env = process.env) {
  const name = env.AGENT_SECRET_SSM_PARAM;
  if (!name) return [];
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1';
  const ssm = new SSMClient({ region });
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const raw = out.Parameter?.Value || '';
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`SSM parameter ${name} is not valid JSON of env vars`);
  }
  const loaded = [];
  for (const [k, v] of Object.entries(obj)) {
    process.env[k] = String(v);
    loaded.push(k);
  }
  return loaded;
}
