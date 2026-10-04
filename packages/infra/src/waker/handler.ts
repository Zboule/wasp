import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { DynamoDBStreamEvent } from 'aws-lambda';

import { threadSessionPolicy } from './policy.ts';
import { actionsFrom, wake } from './waker.ts';

/**
 * The waker Lambda. It runs OUTSIDE the sandbox: it is the only thing that mints
 * thread-scoped credentials and reads the Claude credential, and it hands both
 * to the one microVM serving that thread (CLAUDE.md, invariants 2 and 3).
 */
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const sts = new STSClient({});
const ssm = new SSMClient({});
const agentcore = new BedrockAgentCoreClient({});
let claudeCache: { value: Record<string, string>; at: number } | null = null;

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  const targets = { tableArn: env('WASP_TABLE_ARN'), bucketArn: env('WASP_BUCKET_ARN'), keyArn: env('WASP_KEY_ARN') };
  await wake(actionsFrom(event), {
    async credentialsFor(threadId) {
      const out = await sts.send(
        new AssumeRoleCommand({
          RoleArn: env('WASP_THREAD_ROLE_ARN'),
          RoleSessionName: `wasp-${threadId}`,
          DurationSeconds: 3600,
          Policy: threadSessionPolicy(threadId, targets)
        })
      );
      const c = out.Credentials!;
      return { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken!, expiration: c.Expiration!.toISOString() };
    },
    async claude() {
      if (claudeCache && Date.now() - claudeCache.at < 5 * 60_000) return claudeCache.value;
      const out = await ssm.send(new GetParameterCommand({ Name: env('WASP_CLAUDE_PARAM'), WithDecryption: true }));
      const parsed = JSON.parse(out.Parameter?.Value ?? '{}') as Record<string, string>;
      const value = Object.fromEntries(Object.entries(parsed).filter(([k]) => k === 'CLAUDE_CODE_OAUTH_TOKEN' || k === 'ANTHROPIC_API_KEY'));
      claudeCache = { value, at: Date.now() };
      return value;
    },
    async invoke(threadId, payload) {
      try {
        const out = await agentcore.send(
          new InvokeAgentRuntimeCommand({
            agentRuntimeArn: env('WASP_RUNTIME_ARN'),
            runtimeSessionId: threadId,
            payload: JSON.stringify(payload),
            contentType: 'application/json',
            accept: 'application/json'
          })
        );
        return out.statusCode ?? 200;
      } catch (error) {
        // The runtime's own refusals (400/409) come back as RuntimeClientError 424.
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 500;
        console.error(`wasp waker: invoke ${threadId} failed (${status}): ${error instanceof Error ? error.message : String(error)}`);
        return status === 424 ? 409 : status;
      }
    }
  });
}
