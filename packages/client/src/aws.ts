import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createDynamoStore } from '@zboule/wasp-store';

import { type WaspClient, createWaspClientWith } from './client.ts';

/** What `WaspAgent` links into the app (`Resource.<name>` in the app's code). */
export type WaspResource = { tableName: string; bucketName: string; kmsKeyId: string; region?: string };

/**
 * The client for an app's API, from the linked WaspAgent:
 *
 *   import { Resource } from 'sst';
 *   const wasp = createWaspClient(Resource.Agent);
 */
export function createWaspClient(resource: WaspResource): WaspClient {
  const region = resource.region ? { region: resource.region } : {};
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient(region), { marshallOptions: { removeUndefinedValues: true } });
  const kms = new KMSClient(region);
  const s3 = new S3Client(region);

  return createWaspClientWith({
    store: createDynamoStore({ tableName: resource.tableName, client: dynamo }),
    async encryptToken(threadId, token) {
      const out = await kms.send(
        new EncryptCommand({ KeyId: resource.kmsKeyId, Plaintext: new TextEncoder().encode(token), EncryptionContext: { threadId } })
      );
      return Buffer.from(out.CiphertextBlob!).toString('base64');
    },
    presign: (ref) => getSignedUrl(s3, new GetObjectCommand({ Bucket: resource.bucketName, Key: ref }), { expiresIn: 900 }),
    async deleteObjects(threadId) {
      for (const prefix of [`sessions/${threadId}/`, `payloads/${threadId}/`]) {
        let token: string | undefined;
        do {
          const out = await s3.send(new ListObjectsV2Command({ Bucket: resource.bucketName, Prefix: prefix, ContinuationToken: token }));
          const keys = (out.Contents ?? []).map((o) => ({ Key: o.Key! }));
          if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: resource.bucketName, Delete: { Objects: keys } }));
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token);
      }
    }
  });
}
