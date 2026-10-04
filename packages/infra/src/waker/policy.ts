export type ThreadPolicyTargets = { tableArn: string; bucketArn: string; keyArn: string };

/**
 * The session policy the waker attaches when it assumes the thread role: the
 * credentials a runner receives reach ONE thread and nothing else
 * (CLAUDE.md, invariant 3). AWS intersects it with the thread role's own policy.
 *
 * Every rule is keyed on the thread id, which is why every stored key starts
 * with it (invariant 4).
 */
export function threadSessionPolicy(threadId: string, { tableArn, bucketArn, keyArn }: ThreadPolicyTargets): string {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error(`not a thread id: ${threadId}`);
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'],
        Resource: tableArn,
        Condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [`T#${threadId}`] } }
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: [`${bucketArn}/sessions/${threadId}/*`, `${bucketArn}/payloads/${threadId}/*`]
      },
      {
        // Without ListBucket a missing transcript reads as AccessDenied instead
        // of "not found", and every thread's first turn fails.
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: bucketArn,
        Condition: { StringLike: { 's3:prefix': [`sessions/${threadId}/*`, `payloads/${threadId}/*`] } }
      },
      {
        Effect: 'Allow',
        Action: 'kms:Decrypt',
        Resource: keyArn,
        Condition: { StringEquals: { 'kms:EncryptionContext:threadId': threadId } }
      }
    ]
  });
}
