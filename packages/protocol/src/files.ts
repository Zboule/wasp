/**
 * Where a thread's files live in S3: `payloads/<threadId>/files/<fileId>/<name>`.
 * Under `payloads/<threadId>/`, so the runner's thread-scoped credentials
 * already reach them (CLAUDE.md, invariants 3 and 4).
 *
 * The agent can write anything under its own `payloads/` prefix, so the client
 * (before attaching a file) and the runner (before turning a key into a local
 * path) both accept only keys that `parseFileRef` recognises.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NAME = /^(?!\.)[\p{L}\p{N}._ ()-]{1,128}$/u;
const MAX_NAME = 128;

/** A name safe as one S3 key segment and one local path segment: no `/`, no leading dot, no control characters. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._ ()-]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!cleaned) return 'file';
  if (cleaned.length <= MAX_NAME) return cleaned;
  // Keep the extension: it is what tells the agent what the file is.
  const ext = /\.[\p{L}\p{N}]{1,10}$/u.exec(cleaned)?.[0] ?? '';
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}

export function fileRef(threadId: string, fileId: string, name: string): string {
  return `payloads/${threadId}/files/${fileId}/${safeFileName(name)}`;
}

export function filesPrefix(threadId: string): string {
  return `payloads/${threadId}/files/`;
}

/** The file id and name of a ref that belongs to `threadId`, or null for anything else. */
export function parseFileRef(threadId: string, ref: string): { id: string; name: string } | null {
  const prefix = filesPrefix(threadId);
  if (!ref.startsWith(prefix)) return null;
  const match = new RegExp(`^(${UUID})/([^/]+)$`, 'i').exec(ref.slice(prefix.length));
  if (!match || !NAME.test(match[2]!)) return null;
  return { id: match[1]!.toLowerCase(), name: match[2]! };
}
