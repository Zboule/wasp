import type { DynamoDBStreamEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { threadSessionPolicy } from './policy.ts';
import { actionsFrom, wake } from './waker.ts';

const T1 = '0b6f8f2e-4a8c-4f5e-9d3b-2f1c7a9e6d10';
const T2 = '7af94e2b-4dd9-50f0-9c9a-8a48519bdef0';
const record = (pk: string, sk: string) => ({ eventName: 'INSERT', dynamodb: { Keys: { PK: { S: pk }, SK: { S: sk } } } });
const stream = (...records: object[]) => ({ Records: records }) as unknown as DynamoDBStreamEvent;

describe('actionsFrom', () => {
  it('drains on a new message or a wake request, refreshes on a credential request, once per thread', () => {
    expect(
      actionsFrom(
        stream(record(`T#${T1}`, 'Q#m1'), record(`T#${T1}`, 'Q#m2'), record(`T#${T1}`, 'CTL#WAKE'), record(`T#${T2}`, 'CTL#CREDENTIALS'))
      )
    ).toEqual([
      { threadId: T1, op: 'drain' },
      { threadId: T2, op: 'refresh' }
    ]);
  });

  it('ignores everything else', () => {
    expect(actionsFrom(stream(record(`T#${T1}`, 'F#0001'), record(`T#${T1}`, 'LEASE'), record('X#1', 'Q#m')))).toEqual([]);
  });
});

describe('wake', () => {
  it('sends a drain the thread credentials and the Claude credential, a refresh only credentials', async () => {
    const sent: object[] = [];
    await wake([{ threadId: T1, op: 'drain' }, { threadId: T2, op: 'refresh' }], {
      credentialsFor: async (threadId) => ({ accessKeyId: `key-${threadId}`, secretAccessKey: 's', sessionToken: 't', expiration: 'x' }),
      claude: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' }),
      invoke: async (_threadId, payload) => (sent.push(payload), 202),
      log: () => undefined
    });
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'drain', threadId: T1, credentials: expect.objectContaining({ accessKeyId: `key-${T1}` }), claude: { CLAUDE_CODE_OAUTH_TOKEN: 'oat' } }),
        { op: 'refresh', threadId: T2, credentials: expect.objectContaining({ accessKeyId: `key-${T2}` }) }
      ])
    );
  });

  it('fails the batch (so the stream retries) only when the runtime itself failed', async () => {
    const deps = (status: number) => ({
      credentialsFor: async () => ({ accessKeyId: 'k', secretAccessKey: 's', sessionToken: 't', expiration: 'x' }),
      claude: async () => ({}),
      invoke: async () => status,
      log: () => undefined
    });
    await expect(wake([{ threadId: T1, op: 'drain' }], deps(409))).resolves.toBeUndefined();
    await expect(wake([{ threadId: T1, op: 'drain' }], deps(503))).rejects.toThrow(/503/);
  });
});

describe('threadSessionPolicy', () => {
  const targets = { tableArn: 'arn:aws:dynamodb:eu-west-1:1:table/wasp', bucketArn: 'arn:aws:s3:::wasp', keyArn: 'arn:aws:kms:eu-west-1:1:key/k' };
  const policy = JSON.parse(threadSessionPolicy(T1, targets));

  // The thread boundary's only automated check until the E2E escape test exists
  // (docs/security-model.md, Verification). Widening it means editing this on purpose.
  it('is exactly this document: its partition, its prefixes, its tokens, nothing else', () => {
    expect(policy).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'],
          Resource: 'arn:aws:dynamodb:eu-west-1:1:table/wasp',
          Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`T#${T1}`] } }
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          Resource: [`arn:aws:s3:::wasp/sessions/${T1}/*`, `arn:aws:s3:::wasp/payloads/${T1}/*`]
        },
        {
          Effect: 'Allow',
          Action: 's3:ListBucket',
          Resource: 'arn:aws:s3:::wasp',
          Condition: { StringLike: { 's3:prefix': [`sessions/${T1}/*`, `payloads/${T1}/*`] } }
        },
        {
          Effect: 'Allow',
          Action: 'kms:Decrypt',
          Resource: 'arn:aws:kms:eu-west-1:1:key/k',
          Condition: { StringEquals: { 'kms:EncryptionContext:threadId': T1 } }
        }
      ]
    });
  });

  it('names no other thread', () => {
    expect(threadSessionPolicy(T1, targets)).not.toContain(T2);
  });

  it('stays under the 2048-character session policy limit', () => {
    const long = { tableArn: `arn:aws:dynamodb:eu-west-1:123456789012:table/${'x'.repeat(100)}`, bucketArn: `arn:aws:s3:::${'b'.repeat(63)}`, keyArn: `arn:aws:kms:eu-west-1:123456789012:key/${'k'.repeat(36)}` };
    expect(threadSessionPolicy(T1, long).length).toBeLessThan(2048);
  });

  it('refuses anything that is not a thread id', () => {
    expect(() => threadSessionPolicy('*', targets)).toThrow();
  });
});
