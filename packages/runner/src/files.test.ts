import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fileRef } from '@zboule/wasp-protocol';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { createS3FileSync, messageForAgent } from './files.ts';

describe('messageForAgent', () => {
  it('leaves a message without files as it is', () => {
    expect(messageForAgent('hi')).toBe('hi');
  });

  it('lists every file under files/<id>/<name>', () => {
    const files = [
      { id: 'a', name: 'notes.txt', mediaType: 'text/plain', size: 12, ref: '' },
      { id: 'b', name: 'big.csv', mediaType: 'text/csv', size: 40_000, ref: '' }
    ];
    expect(messageForAgent('', files)).toBe(
      '[The user attached 2 files, in your working directory:\n- files/a/notes.txt (text/plain, 12 B)\n- files/b/big.csv (text/csv, 39.1 KB)]'
    );
  });
});

/** Integration: runs against an S3-compatible server when WASP_S3_ENDPOINT is set (`docker compose -f docker-compose.test.yml up`; CI's integration job). */
const endpoint = process.env.WASP_S3_ENDPOINT;

(endpoint ? describe : describe.skip)('S3 file sync (S3Mock)', () => {
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.WASP_S3_KEY ?? 'test', secretAccessKey: process.env.WASP_S3_SECRET ?? 'test' }
  });
  const bucket = `wasp-test-${crypto.randomUUID().slice(0, 8)}`;
  const put = (Key: string, Body: string) => client.send(new PutObjectCommand({ Bucket: bucket, Key, Body }));

  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  it('restores the thread’s files into an empty working directory, once', async () => {
    const threadId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    await put(fileRef(threadId, fileId, 'notes.txt'), 'hello');
    const dir = mkdtempSync(path.join(tmpdir(), 'wasp-files-'));
    const sync = createS3FileSync({ client, bucket, threadId, dir });

    await sync();
    const local = path.join(dir, 'files', fileId, 'notes.txt');
    expect(readFileSync(local, 'utf8')).toBe('hello');

    await put(fileRef(threadId, fileId, 'notes.txt'), 'changed in S3');
    await sync();
    expect(readFileSync(local, 'utf8')).toBe('hello');
  });

  it('ignores keys that are not files of this thread, including ones that would leave the directory', async () => {
    const threadId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    await put(`payloads/${threadId}/files/${fileId}/../../escaped.txt`, 'x');
    await put(`payloads/${threadId}/files/${fileId}/.bashrc`, 'x');
    await put(`payloads/${threadId}/files/not-an-id/a.txt`, 'x');
    const dir = mkdtempSync(path.join(tmpdir(), 'wasp-files-'));
    const logged: string[] = [];

    await createS3FileSync({ client, bucket, threadId, dir, log: (m) => logged.push(m) })();

    expect(existsSync(path.join(dir, 'files'))).toBe(false);
    expect(existsSync(path.join(dir, '..', 'escaped.txt'))).toBe(false);
    expect(logged).toEqual([]);
  });
});
