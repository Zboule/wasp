import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDynamoStore } from '@zboule/wasp-store';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';

import { callerIdentity } from './caller.ts';
import { loadConfig } from './config.ts';
import type { RunnerReady } from './launcher.ts';
import { createS3Files } from './files.ts';
import { createMcpProxy } from './mcpProxy.ts';
import { createS3SessionStore } from './s3SessionStore.ts';
import { type SdkAgentConfig, sdkAgent, threadWorkDir, warmUpCli } from './sdkAgent.ts';
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
/** Set by the image when the definition has a `skills/` folder. */
const pluginDir = process.env.WASP_PLUGIN_DIR;
const config = loadConfig(process.env, (file) => readFileSync(file, 'utf8'));

/** The agent as every thread runs it. */
const agentConfig: SdkAgentConfig = {
  model: config.model,
  workDir,
  ...(systemPrompt ? { systemPrompt } : {}),
  maxTurns: config.maxTurns,
  maxBudgetUsd: config.maxBudgetUsd,
  ...(config.tools ? { tools: config.tools } : {}),
  ...(config.disallowedTools ? { disallowedTools: config.disallowedTools } : {}),
  ...(pluginDir ? { pluginDir } : {})
};

if (process.env.WASP_WARM_UP === '1') {
  // Run by the launcher before the microVM is snapshotted (launcher.ts): load, warm, leave.
  await warmUpCli(agentConfig);
  process.exit(0);
}

// The first random value this process draws, at the same point in every runner: microVMs restored from
// one snapshot log different ones only if their random state is their own (CLAUDE.md, invariant 7).
console.log(`wasp runner: instance ${crypto.randomUUID()}`);

// One microVM serves one thread, so one proxy and one current caller token.
const proxy = config.mcpServers ? createMcpProxy(config.mcpServers) : undefined;
const mcpServers = proxy ? await proxy.start() : undefined;

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
      ...(proxy
        ? {
            useCaller: callerIdentity({
              setToken: proxy.setToken,
              // The thread's own credentials can only decrypt with this thread's encryption context.
              async decrypt(ciphertext) {
                const kms = new KMSClient({ region, credentials: provider(credentials) });
                const out = await kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertext, 'base64'), EncryptionContext: { threadId } }));
                return new TextDecoder().decode(out.Plaintext);
              }
            })
          }
        : {}),
      agent: sdkAgent({
        ...agentConfig,
        sessionStore: createS3SessionStore({ client: s3, bucket, threadId }),
        claude,
        // The SDK sees only the local proxy URLs: no token in its configuration.
        ...(mcpServers ? { mcpServers } : {}),
        ...(proxy ? { callerMcpServers: proxy.callerServers } : {})
      })
    };
  }
});

// Started by the launcher (launcher.ts), on the first invocation: localhost only, on a free port it forwards to.
const launcher = process.send?.bind(process);
if (!launcher) throw new Error('wasp: runner.mjs runs under launcher.mjs');
server.listen(0, '127.0.0.1', () => {
  const ready: RunnerReady = { port: (server.address() as AddressInfo).port };
  launcher(ready);
});
