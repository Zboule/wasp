import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createDynamoStore } from '@zboule/wasp-store';

import { type FileLimits, type WaspClient, createWaspClientWith } from './client.ts';

/** What `WaspAgent` links into the app (`Resource.<name>` in the app's code). */
export type WaspResource = { tableName: string; bucketName: string; kmsKeyId: string; region?: string };

/**
 * The client for an app's API, from the linked WaspAgent:
 *
 *   import { Resource } from 'sst';
 *   const wasp = createWaspClient(Resource.Agent);
 */
export function createWaspClient(resource: WaspResource, options: { limits?: Partial<FileLimits> } = {}): WaspClient {
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
    presign: (ref, { download, asText } = {}) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: resource.bucketName,
          Key: ref,
          // A user's file is never rendered on the bucket's origin: an uploaded .html would otherwise run there.
          ...(download ? { ResponseContentDisposition: contentDisposition(download) } : {}),
          ...(asText ? { ResponseContentType: 'text/plain; charset=utf-8' } : {})
        }),
        { expiresIn: 900 }
      ),
    presignUpload: (ref, { mediaType, size }) =>
      createPresignedPost(s3, {
        Bucket: resource.bucketName,
        Key: ref,
        Conditions: [
          ['content-length-range', size, size],
          ['eq', '$Content-Type', mediaType]
        ],
        Fields: { 'Content-Type': mediaType },
        Expires: 600
      }),
    async headObject(ref) {
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket: resource.bucketName, Key: ref }));
        return { size: out.ContentLength ?? 0, mediaType: out.ContentType ?? 'application/octet-stream' };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    ...(options.limits ? { limits: options.limits } : {}),
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

/** RFC 6266 with an RFC 5987 name, so quotes and non-ASCII letters cannot break the header. */
function contentDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}
