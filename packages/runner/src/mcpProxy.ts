import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

/**
 * An MCP server the agent may call. `caller`: every request carries the token
 * of the message whose turn is running (the app's user, or a service account
 * the app minted for). `none`: no credential.
 */
export type McpServerSpec = { url: string; auth?: 'caller' | 'none' };

/** Hop-by-hop and per-connection headers are not forwarded; neither is the agent's own Authorization. */
const DROPPED_REQUEST = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'authorization', 'proxy-authorization', 'upgrade']);
/** fetch() has already decoded the body, so its encoding and length no longer apply. */
const DROPPED_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

/**
 * A localhost proxy in front of the app's MCP servers. The SDK is configured
 * once per session with stable local URLs; the credential behind them follows
 * the turn: `setToken` is called for each delivered message, so a turn never
 * runs with another principal's token, and a message without one runs with none.
 *
 * The agent can reach this port and read its process memory, so it can use the
 * token directly: the token is the agent's to act with, inside its own thread
 * (CLAUDE.md, accepted risks). What it must never reach is another thread's.
 */
export function createMcpProxy(servers: Record<string, McpServerSpec>) {
  let token: string | undefined;

  const server = createServer((req, res) => {
    void forward(req, res).catch((error: unknown) => {
      console.error('wasp mcp proxy:', error instanceof Error ? error.message : error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
  });

  async function forward(req: IncomingMessage, res: ServerResponse) {
    const local = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/mcp\/([^/]+)$/.exec(local.pathname);
    const spec = match ? servers[decodeURIComponent(match[1]!)] : undefined;
    if (!spec) {
      res.writeHead(404).end();
      return;
    }
    const target = new URL(spec.url);
    local.searchParams.forEach((value, key) => target.searchParams.set(key, value));

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || DROPPED_REQUEST.has(key)) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
    }
    if (spec.auth === 'caller' && token) headers.set('authorization', `Bearer ${token}`);

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const upstream = await fetch(target, {
      method: req.method ?? 'GET',
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      redirect: 'manual',
      signal: abort.signal
    });
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (!DROPPED_RESPONSE.has(key)) out[key] = value;
    });
    res.writeHead(upstream.status, out);
    // Streamed through: MCP answers may be server-sent events.
    if (upstream.body) Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res);
    else res.end();
  }

  return {
    /** Listens on a random localhost port; resolves to the SDK's server config. */
    async start(): Promise<Record<string, { type: 'http'; url: string }>> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return Object.fromEntries(
        Object.keys(servers).map((name) => [name, { type: 'http' as const, url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}` }])
      );
    },
    /** The credential for what follows: the delivered message's token, or none. */
    setToken(next: string | undefined) {
      token = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

export type McpProxy = ReturnType<typeof createMcpProxy>;
