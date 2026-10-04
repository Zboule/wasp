import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { type WaspFile, filesPrefix, parseFileRef } from '@zboule/wasp-protocol';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A thread's uploaded files, in the agent's working directory. Neither method
 * throws: a file that cannot be fetched is logged and skipped, and the message
 * still reaches the agent, which finds the file missing.
 */
export type ThreadFiles = {
  /** Every file of the thread not on disk yet: a recycled microVM starts empty while the transcript still names them. */
  restoreAll(): Promise<void>;
  /** These files, before the agent reads the message that attaches them. */
  fetch(files: WaspFile[]): Promise<void>;
};

/** Where a file sits, relative to the thread's working directory (the agent's cwd). */
export function localFilePath(file: Pick<WaspFile, 'id' | 'name'>): string {
  return `files/${file.id}/${file.name}`;
}

export function createS3Files({
  client,
  bucket,
  threadId,
  dir,
  log = (message: string) => console.error(message)
}: {
  client: S3Client;
  bucket: string;
  threadId: string;
  dir: string;
  log?: (message: string) => void;
}): ThreadFiles {
  const report = (what: string, error: unknown) => log(`files ${threadId}: ${what}: ${error instanceof Error ? error.message : String(error)}`);

  async function download(ref: string): Promise<void> {
    // Only refs shaped like a file become paths. The agent could write other keys
    // under its own prefix; that harms nobody else, but they are not files to place.
    const file = parseFileRef(threadId, ref);
    if (!file) return;
    const target = path.join(dir, localFilePath(file));
    if (existsSync(target)) return;
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: ref }));
      await mkdir(path.dirname(target), { recursive: true });
      // Written aside then renamed, so an interrupted download never looks complete.
      await writeFile(`${target}.part`, await out.Body!.transformToByteArray());
      await rename(`${target}.part`, target);
    } catch (error) {
      report(ref, error);
    }
  }

  async function list(): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: filesPrefix(threadId), ContinuationToken: token }));
      keys.push(...(out.Contents ?? []).map((o) => o.Key!).filter(Boolean));
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  return {
    async restoreAll() {
      try {
        await Promise.all((await list()).map(download));
      } catch (error) {
        report('list', error);
      }
    },
    async fetch(files) {
      await Promise.all(files.map((file) => download(file.ref)));
    }
  };
}
