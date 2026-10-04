import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpProxy } from './mcpProxy.ts';

/** A stand-in for the app's MCP server: echoes what it received, or streams events. */
async function upstream() {
  const seen: { auth?: string; session?: string; body: string; path: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string, body: Buffer.concat(chunks).toString(), path: req.url! });
    if (req.url?.startsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's-1' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('MCP proxy', () => {
  it('sends the current caller token, follows token changes, and sends none when cleared', async () => {
    const app = await upstream();
    const proxy = createMcpProxy({ app: { url: `${app.base}/mcp`, auth: 'caller' }, docs: { url: `${app.base}/docs` } });
    const urls = await proxy.start();
    cleanups.push(app.close, proxy.close);

    const call = () =>
      fetch(urls.app!.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer agent-made-this-up' }, body: '{"id":1}' });

    proxy.setToken('token-a');
    expect(await (await call()).json()).toEqual({ ok: true });
    proxy.setToken('token-b');
    await call();
    proxy.setToken(undefined);
    await call();
    await fetch(urls.docs!.url, { method: 'POST', body: '{}' });

    expect(app.seen.map((s) => s.auth)).toEqual(['Bearer token-a', 'Bearer token-b', undefined, undefined]);
    expect(app.seen[0]).toMatchObject({ body: '{"id":1}', path: '/mcp' });
    expect(app.seen[3]?.path).toBe('/docs');
  });

  it('passes MCP session headers both ways and streams event-stream answers', async () => {
    const app = await upstream();
    const proxy = createMcpProxy({ app: { url: `${app.base}/sse`, auth: 'caller' } });
    const urls = await proxy.start();
    cleanups.push(app.close, proxy.close);

    const res = await fetch(urls.app!.url, { headers: { 'mcp-session-id': 's-1', accept: 'text/event-stream' } });
    expect(res.headers.get('mcp-session-id')).toBe('s-1');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: one\n\ndata: two\n\n');
    expect(app.seen[0]?.session).toBe('s-1');
  });

  it('knows only the configured servers', async () => {
    const proxy = createMcpProxy({ app: { url: 'http://127.0.0.1:9/never' } });
    const urls = await proxy.start();
    cleanups.push(proxy.close);
    const unknown = urls.app!.url.replace('/mcp/app', '/mcp/other');
    expect((await fetch(unknown)).status).toBe(404);
    expect((await fetch(urls.app!.url.replace('/mcp/app', '/elsewhere'))).status).toBe(404);
  });
});
