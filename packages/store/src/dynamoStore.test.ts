import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe } from 'vitest';

import { createDynamoStore } from './dynamoStore.ts';
import { storeContract } from './testing/contract.ts';

/** Integration: runs against DynamoDB Local when WASP_DYNAMODB_ENDPOINT is set (`docker compose -f docker-compose.test.yml up`; CI's integration job). */
const endpoint = process.env.WASP_DYNAMODB_ENDPOINT;

if (endpoint) {
  const raw = new DynamoDBClient({ endpoint, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  const client = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  const tableName = `wasp-test-${crypto.randomUUID()}`;
  let created: Promise<unknown> | undefined;
  const ensureTable = () =>
    (created ??= raw.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' }
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' }
        ]
      })
    ));
  storeContract('dynamodb', async () => {
    await ensureTable();
    return createDynamoStore({ tableName, client });
  });
} else {
  describe.skip('ThreadStore contract: dynamodb (set WASP_DYNAMODB_ENDPOINT)', () => {});
}
