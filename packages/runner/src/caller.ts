import type { StoredMessage } from '@zboule/wasp-store';

import type { CallerResult } from './drain.ts';

/**
 * Turns each delivered message's caller token into the credential of the MCP
 * calls that follow (CLAUDE.md, invariant 5): decrypted only for delivery, kept
 * in memory only, never logged, never written to the feed, the transcript or a
 * prompt. A message without a token clears it: a turn never acts with the
 * previous principal's token. A token that cannot be used clears it too, except
 * for a message joining the running turn (`asap`): that turn keeps its credential.
 */
export function callerIdentity(deps: {
  /** KMS Decrypt with the thread's own credentials and encryption context. */
  decrypt: (ciphertext: string) => Promise<string>;
  setToken: (token: string | undefined) => void;
  now?: () => number;
}): (message: StoredMessage, joining?: boolean) => Promise<CallerResult> {
  const now = deps.now ?? Date.now;
  return async (message, joining = false) => {
    const fail = (reason: 'token_expired' | 'invalid'): CallerResult => {
      if (!joining) deps.setToken(undefined);
      return { ok: false, reason };
    };
    if (!message.callerToken) {
      deps.setToken(undefined);
      return { ok: true };
    }
    let token: string;
    try {
      token = await deps.decrypt(message.callerToken);
    } catch (error) {
      // The error names the failure (e.g. AccessDenied), never the token.
      console.error(`wasp: the caller token of message ${message.id} could not be decrypted (${error instanceof Error ? error.name : 'error'})`);
      return fail('invalid');
    }
    if (jwtExpired(token, now())) return fail('token_expired');
    deps.setToken(token);
    return { ok: true };
  };
}

/** True for a JWT whose `exp` has passed. Any other token is the MCP server's to judge. */
export function jwtExpired(token: string, at: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof exp === 'number' && exp * 1000 <= at;
  } catch {
    return false;
  }
}
