import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { type WaspFile, filesPrefix, parseFileRef } from '@zboule/wasp-protocol';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Where a file sits, relative to the thread's working directory (the agent's cwd). */
export function localFilePath(file: Pick<WaspFile, 'id' | 'name'>): string {
  return `files/${file.id}/${file.name}`;
}

/** The message as the agent reads it: the user's text, then where each attached file is. */
export function messageForAgent(text: string, attachments: WaspFile[] = []): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((f) => `- ${localFilePath(f)} (${f.mediaType}, ${formatSize(f.size)})`);
  const note = `[The user attached ${attachments.length === 1 ? 'a file' : `${attachments.length} files`}, in your working directory:\n${lines.join('\n')}]`;
  return text.trim() ? `${text}\n\n${note}` : note;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Copies the thread's files from S3 into `<dir>/files/` when they are not there
 * yet. A recycled microVM starts empty while the transcript still names those
 * paths, so this runs when a session opens as well as before a delivery.
 *
 * Keys come from a prefix the agent can write to, so only those `parseFileRef`
 * accepts become paths. A file that fails to download is logged and skipped:
 * the message still reaches the agent, which finds the file missing.
 */
export function createS3FileSync({
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
}): () => Promise<void> {
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

  return async () => {
    for (const key of await list()) {
      const file = parseFileRef(threadId, key);
      if (!file) continue;
      const target = path.join(dir, localFilePath(file));
      if (existsSync(target)) continue;
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        await mkdir(path.dirname(target), { recursive: true });
        // Written aside then renamed, so an interrupted download never looks complete.
        await writeFile(`${target}.part`, await out.Body!.transformToByteArray());
        await rename(`${target}.part`, target);
      } catch (error) {
        log(`file ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
