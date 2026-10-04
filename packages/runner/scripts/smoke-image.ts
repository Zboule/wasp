/**
 * The runner image end to end, on a laptop: real container, real model,
 * DynamoDB Local + S3Mock standing in for AWS.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   pnpm --filter @jorna/wasp-runner image
 *   CLAUDE_CODE_OAUTH_TOKEN=… node packages/runner/scripts/smoke-image.ts
 */
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDynamoStore } from '@jorna/wasp-store';
import { execFileSync } from 'node:child_process';

const local = { region: 'eu-west-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } };
const dynamo = new DynamoDBClient({ ...local, endpoint: 'http://localhost:8000' });
const s3 = new S3Client({ ...local, endpoint: 'http://localhost:9090', forcePathStyle: true });
const table = `wasp-smoke-${Date.now()}`;
const bucket = `wasp-smoke-${Date.now()}`;
await dynamo.send(
  new CreateTableCommand({
    TableName: table,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }]
  })
);
await s3.send(new CreateBucketCommand({ Bucket: bucket }));
const store = createDynamoStore({ tableName: table, client: DynamoDBDocumentClient.from(dynamo) });

const container = execFileSync('docker', [
  'run', '-d', '--rm', '-p', '8788:8080',
  '-e', `WASP_TABLE=${table}`, '-e', `WASP_BUCKET=${bucket}`, '-e', 'WASP_MODEL=claude-haiku-4-5',
  '-e', 'WASP_DYNAMODB_ENDPOINT=http://host.docker.internal:8000', '-e', 'WASP_S3_ENDPOINT=http://host.docker.internal:9090',
  'wasp-runner:local'
]).toString().trim();
const stop = () => execFileSync('docker', ['rm', '-f', container]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch('http://localhost:8788/ping')).ok) break; } catch { /* not up yet */ }
    await sleep(200);
  }
  const thread = crypto.randomUUID();
  const credentials = { ...local.credentials, sessionToken: 'local', expiration: new Date(Date.now() + 3_600_000).toISOString() };
  const turn = async (text: string) => {
    await store.enqueue(thread, { id: crypto.randomUUID(), text, deliver: 'later', createdAt: Date.now() });
    const res = await fetch('http://localhost:8788/invocations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': thread },
      body: JSON.stringify({ op: 'drain', threadId: thread, credentials, claude: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } })
    });
    console.log(`invoke → ${res.status}`);
    for (let i = 0; i < 300; i++) {
      const status = ((await (await fetch('http://localhost:8788/ping')).json()) as { status: string }).status;
      if (status === 'Healthy' && (await store.pending(thread)).length === 0) return;
      await sleep(500);
    }
    throw new Error('turn never finished');
  };

  await turn('Run `uname -m` with Bash and reply with only its output.');
  await turn('What did the previous command print? Reply with only that word.');

  for (const { event: e } of await store.feed(thread)) {
    if (e.type === 'CUSTOM') console.log(`> ${'text' in e.value ? e.value.text : e.name}`);
    if (e.type === 'TEXT_MESSAGE_CONTENT') console.log(`  ${e.delta.trim()}`);
    if (e.type === 'TOOL_CALL_START') console.log(`  [${e.toolCallName}]`);
    if (e.type === 'RUN_FINISHED') console.log(`  -- ${e.result.outcome}`);
    if (e.type === 'RUN_ERROR') console.log(`  -- error: ${e.message}`);
  }
  const transcript = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `sessions/${thread}/` }));
  console.log(`transcript chunks under sessions/${thread}/: ${transcript.KeyCount}`);
} finally {
  console.log(execFileSync('docker', ['logs', container]).toString().split('\n').slice(-5).join('\n'));
  stop();
}
