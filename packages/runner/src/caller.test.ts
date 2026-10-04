import type { StoredMessage } from '@zboule/wasp-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { callerIdentity, jwtExpired } from './caller.ts';

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ sub: 'u', exp })).toString('base64url')}.s`;
const message = (callerToken?: string): StoredMessage => ({
  id: 'm1',
  text: 'hi',
  deliver: 'later',
  createdAt: 1,
  order: 'o',
  ...(callerToken ? { callerToken } : {})
});

afterEach(() => vi.restoreAllMocks());

describe('caller identity', () => {
  it('uses the decrypted token, clears it for a message without one, and refuses an expired JWT', async () => {
    const tokens: (string | undefined)[] = [];
    const use = callerIdentity({ decrypt: async (c) => c.replace('enc:', ''), setToken: (t) => tokens.push(t), now: () => 2_000_000 });

    expect(await use(message(`enc:${jwt(3_000)}`))).toEqual({ ok: true });
    expect(await use(message())).toEqual({ ok: true });
    expect(await use(message(`enc:${jwt(1_000)}`))).toEqual({ ok: false, reason: 'token_expired' });
    expect(await use(message('enc:opaque-token'))).toEqual({ ok: true });
    expect(tokens).toEqual([undefined, jwt(3_000), undefined, undefined, undefined, 'opaque-token']);
  });

  it('fails a token it cannot decrypt, and never logs a token', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void logs.push(args.join(' ')));
    const use = callerIdentity({
      decrypt: async () => {
        const error = new Error('denied for ciphertext SECRET-CIPHER');
        error.name = 'AccessDeniedException';
        throw error;
      },
      setToken: () => undefined
    });
    expect(await use(message('SECRET-CIPHER'))).toEqual({ ok: false, reason: 'invalid' });
    expect(logs.join('\n')).toContain('AccessDeniedException');
    expect(logs.join('\n')).not.toContain('SECRET');
  });

  it('reads only JWT expiry', () => {
    expect(jwtExpired(jwt(1), 5_000)).toBe(true);
    expect(jwtExpired('not.a.jwt!', 5_000)).toBe(false);
    expect(jwtExpired('opaque', 5_000)).toBe(false);
  });
});
