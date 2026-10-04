import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDynamoStore } from '@zboule/wasp-store';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { createS3Files } from './files.ts';
import { createS3SessionStore } from './s3SessionStore.ts';
import { sdkAgent, threadWorkDir } from './sdkAgent.ts';
import { type ThreadCredentials, createRunnerServer } from './server.ts';

/**
 * The image's entry point. Configuration comes from the runtime's environment
 * (set by WaspAgent); credentials only ever come from the waker's invocation.
 */
const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
};

const region = env('AWS_REGION', 'eu-west-1');
const tableName = env('WASP_TABLE');
const bucket = env('WASP_BUCKET');
const systemPromptFile = process.env.WASP_SYSTEM_PROMPT_FILE;
const workDir = env('WASP_WORK_DIR', '/work');
const systemPrompt = systemPromptFile ? readFileSync(systemPromptFile, 'utf8') : process.env.WASP_SYSTEM_PROMPT;

/** The SDK clients take a provider, so a refresh from the waker applies to the next call. */
const provider = (credentials: () => ThreadCredentials) => async () => {
  const c = credentials();
  return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, expiration: new Date(c.expiration) };
};

const server = createRunnerServer({
  owner: `${hostname()}-${process.pid}`,
  forThread(threadId, credentials, claude) {
    const local = { ...(process.env.WASP_DYNAMODB_ENDPOINT ? { endpoint: process.env.WASP_DYNAMODB_ENDPOINT } : {}) };
    const dynamo = new DynamoDBClient({ region, credentials: provider(credentials), ...local });
    const s3 = new S3Client({
      region,
      credentials: provider(credentials),
      ...(process.env.WASP_S3_ENDPOINT ? { endpoint: process.env.WASP_S3_ENDPOINT, forcePathStyle: true } : {})
    });
    return {
      store: createDynamoStore({ tableName, client: DynamoDBDocumentClient.from(dynamo, { marshallOptions: { removeUndefinedValues: true } }) }),
      async offload(thread, content) {
        const key = `payloads/${thread}/${crypto.randomUUID()}.txt`;
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: 'text/plain; charset=utf-8' }));
        return key;
      },
      files: createS3Files({ client: s3, bucket, threadId, dir: threadWorkDir(workDir, threadId) }),
      agent: sdkAgent({
        model: env('WASP_MODEL', 'claude-sonnet-5-5'),
        workDir,
        sessionStore: createS3SessionStore({ client: s3, bucket, threadId }),
        claude,
        ...(systemPrompt ? { systemPrompt } : {}),
        maxTurns: Number(env('WASP_MAX_TURNS', '40')),
        maxBudgetUsd: Number(env('WASP_MAX_BUDGET_USD', '5'))
      })
    };
  }
});

const port = Number(env('PORT', '8080'));
server.listen(port, '0.0.0.0', () => console.log(`wasp runner listening on :${port}`));
