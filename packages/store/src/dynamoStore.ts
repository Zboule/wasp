import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import type { FeedEntry, FeedEvent } from '@zboule/wasp-protocol';

import { type CancelResult, type NewMessage, type StoredMessage, type ThreadStore, orderKey } from './store.ts';

/**
 * One table, one partition per thread. Every key starts with the thread id:
 * that is what lets the runner's thread-scoped credentials
 * (`dynamodb:LeadingKeys = T#<threadId>`) reach exactly one thread. See the
 * security invariants in CLAUDE.md before adding any item type.
 *
 *   PK            SK              item
 *   T#<thread>    Q#<messageId>   queued message (delivered ones are kept, then expire)
 *   T#<thread>    F#<cursor>      feed event
 *   T#<thread>    LEASE           the one runner draining the thread
 *   T#<thread>    CTL#INTERRUPT   a pending interrupt request
 *   T#<thread>    CTL#WAKE        "start a drain": the stream wakes the runtime
 *   T#<thread>    CTL#CREDENTIALS "refresh my credentials": the stream sends fresh ones
 */
export function createDynamoStore({ tableName, client }: { tableName: string; client: DynamoDBDocumentClient }): ThreadStore {
  const pk = (threadId: string) => `T#${threadId}`;
  const DELIVERED_TTL_SECONDS = 7 * 24 * 3600;
  let counter = 0;

  const conditionFailed = (error: unknown) => error instanceof ConditionalCheckFailedException || (error as { name?: string })?.name === 'ConditionalCheckFailedException';

  type WriteRequest = { PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: Record<string, unknown> } };
  async function batchWrite(requests: WriteRequest[]) {
    for (let i = 0; i < requests.length; i += 25) {
      let pending: WriteRequest[] | undefined = requests.slice(i, i + 25);
      for (let attempt = 0; pending?.length; attempt++) {
        if (attempt > 6) throw new Error(`DynamoDB left ${pending.length} writes unprocessed`);
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
        const out = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));
        pending = out.UnprocessedItems?.[tableName] as WriteRequest[] | undefined;
      }
    }
  }

  /** Every item of a thread whose sort key starts with `prefix` (all of them for ''). */
  async function queryAll(threadId: string, prefix: string) {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: prefix ? 'PK = :pk AND begins_with(SK, :prefix)' : 'PK = :pk',
          ExpressionAttributeValues: prefix ? { ':pk': pk(threadId), ':prefix': prefix } : { ':pk': pk(threadId) },
          ConsistentRead: true,
          ExclusiveStartKey: start
        })
      );
      items.push(...(out.Items ?? []));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  return {
    async enqueue(threadId, message: NewMessage) {
      const stored: StoredMessage = { ...message, order: orderKey(message.deliver, message.createdAt, message.id) };
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { PK: pk(threadId), SK: `Q#${message.id}`, ...stored, delivered: false },
          ConditionExpression: 'attribute_not_exists(PK)'
        })
      );
      return stored;
    },

    async pending(threadId) {
      const items = await queryAll(threadId, 'Q#');
      return items
        .filter((item) => item.delivered === false)
        .map(({ PK: _pk, SK: _sk, delivered: _d, ...m }) => m as StoredMessage)
        .sort((a, b) => a.order.localeCompare(b.order));
    },

    async claim(threadId, messageId, at) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: pk(threadId), SK: `Q#${messageId}` },
            UpdateExpression: 'SET delivered = :true, deliveredAt = :at, expiresAt = :ttl REMOVE callerToken',
            ConditionExpression: 'delivered = :false',
            ExpressionAttributeValues: { ':true': true, ':false': false, ':at': at, ':ttl': Math.floor(at / 1000) + DELIVERED_TTL_SECONDS }
          })
        );
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },

    async cancel(threadId, messageId): Promise<CancelResult> {
      try {
        await client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: pk(threadId), SK: `Q#${messageId}` },
            ConditionExpression: 'delivered = :false',
            ExpressionAttributeValues: { ':false': false }
          })
        );
        return 'cancelled';
      } catch (error) {
        if (!conditionFailed(error)) throw error;
        const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: { PK: pk(threadId), SK: `Q#${messageId}` } }));
        return Item ? 'delivered' : 'missing';
      }
    },

    async append(threadId, events: FeedEvent[], at) {
      const entries: FeedEntry[] = events.map((event) => ({
        // Time first so cursors increase across runners; the counter orders one runner's writes within a millisecond.
        cursor: `${String(at).padStart(13, '0')}-${String(++counter % 1_000_000).padStart(6, '0')}`,
        at,
        event
      }));
      await batchWrite(
        entries.map((entry) => ({
          PutRequest: { Item: { PK: pk(threadId), SK: `F#${entry.cursor}`, at: entry.at, event: JSON.stringify(entry.event) } }
        }))
      );
      return entries;
    },

    async feed(threadId, { after = null, limit = 500 } = {}) {
      const out = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':pk': pk(threadId), ':from': after ? `F#${after}\u0000` : 'F#', ':to': 'F#￿' },
          ConsistentRead: true,
          Limit: limit
        })
      );
      return (out.Items ?? []).map((item) => ({
        cursor: String(item.SK).slice(2),
        at: Number(item.at),
        event: JSON.parse(String(item.event)) as FeedEvent
      }));
    },

    async acquireLease(threadId, owner, until, now) {
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: { PK: pk(threadId), SK: 'LEASE', owner, until },
            ConditionExpression: 'attribute_not_exists(PK) OR #until <= :now',
            ExpressionAttributeNames: { '#until': 'until' },
            ExpressionAttributeValues: { ':now': now }
          })
        );
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },

    async renewLease(threadId, owner, until) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: pk(threadId), SK: 'LEASE' },
            UpdateExpression: 'SET #until = :until',
            ConditionExpression: '#owner = :owner',
            ExpressionAttributeNames: { '#until': 'until', '#owner': 'owner' },
            ExpressionAttributeValues: { ':until': until, ':owner': owner }
          })
        );
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },

    async releaseLease(threadId, owner) {
      try {
        await client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { PK: pk(threadId), SK: 'LEASE' },
            ConditionExpression: '#owner = :owner',
            ExpressionAttributeNames: { '#owner': 'owner' },
            ExpressionAttributeValues: { ':owner': owner }
          })
        );
      } catch (error) {
        if (!conditionFailed(error)) throw error;
      }
    },

    async leaseHolder(threadId, now) {
      const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: { PK: pk(threadId), SK: 'LEASE' }, ConsistentRead: true }));
      return Item && Number(Item.until) > now ? String(Item.owner) : null;
    },

    async requestWake(threadId, at) {
      await client.send(new PutCommand({ TableName: tableName, Item: { PK: pk(threadId), SK: 'CTL#WAKE', at } }));
    },

    async requestCredentials(threadId, at) {
      await client.send(new PutCommand({ TableName: tableName, Item: { PK: pk(threadId), SK: 'CTL#CREDENTIALS', at } }));
    },

    async requestInterrupt(threadId, at) {
      await client.send(new PutCommand({ TableName: tableName, Item: { PK: pk(threadId), SK: 'CTL#INTERRUPT', at } }));
    },

    async takeInterrupt(threadId) {
      const { Attributes } = await client.send(
        new DeleteCommand({ TableName: tableName, Key: { PK: pk(threadId), SK: 'CTL#INTERRUPT' }, ReturnValues: 'ALL_OLD' })
      );
      return Attributes !== undefined;
    },

    async deleteThread(threadId) {
      const keys = (await queryAll(threadId, '')).map((item) => ({ PK: item.PK, SK: item.SK }));
      await batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
    }
  };
}
