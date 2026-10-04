import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fileRef } from '@zboule/wasp-protocol';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { createS3Files } from './files.ts';

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
    const files = createS3Files({ client, bucket, threadId, dir });

    await files.restoreAll();
    const local = path.join(dir, 'files', fileId, 'notes.txt');
    expect(readFileSync(local, 'utf8')).toBe('hello');

    await put(fileRef(threadId, fileId, 'notes.txt'), 'changed in S3');
    await files.restoreAll();
    expect(readFileSync(local, 'utf8')).toBe('hello');
  });

  it('fetches only the files it is given', async () => {
    const threadId = crypto.randomUUID();
    const [wanted, other] = [crypto.randomUUID(), crypto.randomUUID()];
    await put(fileRef(threadId, wanted, 'a.txt'), 'a');
    await put(fileRef(threadId, other, 'b.txt'), 'b');
    const dir = mkdtempSync(path.join(tmpdir(), 'wasp-files-'));

    await createS3Files({ client, bucket, threadId, dir }).fetch([{ id: wanted, name: 'a.txt', mediaType: 'text/plain', size: 1, ref: fileRef(threadId, wanted, 'a.txt') }]);

    expect(existsSync(path.join(dir, 'files', wanted, 'a.txt'))).toBe(true);
    expect(existsSync(path.join(dir, 'files', other))).toBe(false);
  });

  it('logs what it cannot fetch instead of throwing', async () => {
    const threadId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const dir = mkdtempSync(path.join(tmpdir(), 'wasp-files-'));
    const logged: string[] = [];
    const missing = { id: fileId, name: 'gone.txt', mediaType: 'text/plain', size: 1, ref: fileRef(threadId, fileId, 'gone.txt') };

    await createS3Files({ client, bucket, threadId, dir, log: (m) => logged.push(m) }).fetch([missing]);
    await createS3Files({ client, bucket: 'no-such-bucket', threadId, dir, log: (m) => logged.push(m) }).restoreAll();

    expect(logged).toEqual([expect.stringContaining('gone.txt'), expect.stringContaining(': list: ')]);
  });

  it('places only keys shaped like files, never outside its directory', async () => {
    const threadId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    await put(`payloads/${threadId}/files/${fileId}/../../escaped.txt`, 'x');
    await put(`payloads/${threadId}/files/${fileId}/.bashrc`, 'x');
    await put(`payloads/${threadId}/files/not-an-id/a.txt`, 'x');
    const dir = mkdtempSync(path.join(tmpdir(), 'wasp-files-'));
    const logged: string[] = [];

    await createS3Files({ client, bucket, threadId, dir, log: (m) => logged.push(m) }).restoreAll();

    expect(existsSync(path.join(dir, 'files'))).toBe(false);
    expect(existsSync(path.join(dir, '..', 'escaped.txt'))).toBe(false);
    expect(logged).toEqual([]);
  });
});
