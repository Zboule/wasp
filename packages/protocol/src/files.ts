/**
 * Where a thread's files live in S3: `payloads/<threadId>/files/<fileId>/<name>`.
 * Under `payloads/<threadId>/`, so the runner's thread-scoped credentials
 * already reach them (CLAUDE.md, invariants 3 and 4).
 *
 * A ref is data the agent can write (in its own feed and queue), so whoever
 * acts on one outside the sandbox parses it first: `parseFileRef` is what
 * keeps a planted ref from naming another thread's object.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAME_CHARS = '\\p{L}\\p{N}._ ()-';
/** In code points, which is what the `u` regexes below count. */
const MAX_NAME = 128;
const NAME = new RegExp(`^(?!\\.)[${NAME_CHARS}]{1,${MAX_NAME}}$`, 'u');
const UNSAFE = new RegExp(`[^${NAME_CHARS}]`, 'gu');

/** A name safe as one S3 key segment and one local path segment: no `/`, no leading dot, no control characters. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize('NFC').replace(UNSAFE, '_').replace(/^[.\s]+/, '').trim();
  const chars = Array.from(cleaned);
  if (chars.length === 0) return 'file';
  if (chars.length <= MAX_NAME) return cleaned;
  // Keep the extension: it is what tells the agent what the file is.
  const ext = Array.from(/\.[\p{L}\p{N}]{1,10}$/u.exec(cleaned)?.[0] ?? '');
  return [...chars.slice(0, MAX_NAME - ext.length), ...ext].join('');
}

export function fileRef(threadId: string, fileId: string, name: string): string {
  return `${filesPrefix(threadId)}${fileId}/${safeFileName(name)}`;
}

export function filesPrefix(threadId: string): string {
  return `payloads/${threadId}/files/`;
}

/**
 * Whether `ref` names an object of this thread's `payloads/` (offloaded tool
 * output, files). Dot segments are refused: a browser would resolve them in
 * the URL and fetch outside the prefix.
 */
export function isPayloadRef(threadId: string, ref: string): boolean {
  const prefix = `payloads/${threadId}/`;
  return ref.startsWith(prefix) && !ref.slice(prefix.length).split('/').some((segment) => segment === '.' || segment === '..');
}

/** The file id and name of a ref that belongs to `threadId`, or null for anything else. */
export function parseFileRef(threadId: string, ref: string): { id: string; name: string } | null {
  const prefix = filesPrefix(threadId);
  if (!ref.startsWith(prefix)) return null;
  const [id, name, ...rest] = ref.slice(prefix.length).split('/');
  if (rest.length || !id || !UUID.test(id) || !name || !NAME.test(name)) return null;
  return { id: id.toLowerCase(), name };
}
