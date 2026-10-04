// Petit Songe delivery sink: the container writes the turn result straight to
// petitsonge's AgentTable via its IAM role. No public ingest endpoint, so
// nothing sits outside the OIDC gateway (see petitsonge docs/agent-chat.md).
//
// On completion it writes: the assistant message, the run's terminal state and
// usage, the per-user usage ledger row, and releases the thread's run lock.
// Item shapes are petitsonge's; keyed by thread id (= book pid) and run id.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

let _doc;
function doc() {
  return (_doc ??= DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION || 'eu-west-1' }),
    { marshallOptions: { removeUndefinedValues: true } },
  ));
}

export async function writeTurnResult({ table, threadId, runId, userId, text, result }) {
  const now = new Date().toISOString();
  const usage = result?.usage || {};
  const costUsd = result?.total_cost_usd ?? 0;
  const status = result?.subtype === 'success' ? 'done' : result?.subtype || 'done';
  const ops = [];

  if (text && text.trim()) {
    ops.push(doc().send(new PutCommand({
      TableName: table,
      Item: { PK: `THREAD#${threadId}`, SK: `MSG#${now}#${randomUUID().slice(0, 8)}`, role: 'assistant', text, runId, ts: now },
    })));
  }
  ops.push(doc().send(new UpdateCommand({
    TableName: table,
    Key: { PK: `RUN#${runId}`, SK: 'META' },
    UpdateExpression: 'SET #s = :s, usage = :u, costUsd = :c, endedAt = :t',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': status, ':u': usage, ':c': costUsd, ':t': now },
  })));
  if (userId) {
    ops.push(doc().send(new PutCommand({
      TableName: table,
      Item: { PK: `USAGE#${userId}`, SK: `${now}#${runId}`, pid: threadId, runId, usage, costUsd, ts: now },
    })));
  }
  // Release the thread's run lock so the next message can start.
  ops.push(doc().send(new DeleteCommand({ TableName: table, Key: { PK: `THREAD#${threadId}`, SK: 'LOCK' } })));

  const settled = await Promise.allSettled(ops);
  const failed = settled.filter((s) => s.status === 'rejected');
  if (failed.length) throw new Error(`sink: ${failed.length}/${ops.length} writes failed: ${failed[0].reason?.message}`);
}
