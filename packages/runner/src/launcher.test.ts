import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createLauncher } from './launcher.ts';

/** A stand-in runner: listens on localhost, reports its port, echoes what it receives. */
const FAKE_RUNNER = `
const http = require('node:http');
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/ping') return res.end(JSON.stringify({ status: 'HealthyBusy' }));
  if (body === 'exit') { res.end('{}'); return setTimeout(() => process.exit(3), 10); }
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ body, session: req.headers['x-amzn-bedrock-agentcore-runtime-session-id'], pid: process.pid }));
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
`;

const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start(script = FAKE_RUNNER) {
  let starts = 0;
  const exits: (number | null)[] = [];
  const launcher = createLauncher({
    startRunner: () => {
      starts++;
      return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    },
    onRunnerExit: (code) => exits.push(code),
    log: () => undefined
  });
  await new Promise<void>((resolve) => launcher.server.listen(0, '127.0.0.1', resolve));
  servers.push({ close: () => (launcher.stop(), launcher.server.close()) });
  const base = `http://127.0.0.1:${(launcher.server.address() as AddressInfo).port}`;
  return { base, starts: () => starts, exits };
}

describe('launcher', () => {
  it('answers health on its own until the first invocation, without starting the runner', async () => {
    const { base, starts } = await start();
    const ping = await fetch(`${base}/ping`);
    expect(await ping.json()).toEqual({ status: 'Healthy' });
    expect(starts()).toBe(0);
  });

  it('starts the runner on the first invocation, once, and forwards requests and answers as they are', async () => {
    const { base, starts } = await start();
    const invoke = (body: string) =>
      fetch(`${base}/invocations`, { method: 'POST', body, headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'thread-1' } });
    const [a, b] = await Promise.all([invoke('one'), invoke('two')]);
    expect(a.status).toBe(202);
    const [first, second] = [await a.json(), await b.json()];
    expect([first.body, second.body].sort()).toEqual(['one', 'two']);
    expect(first.session).toBe('thread-1');
    expect(first.pid).toBe(second.pid);
    expect(starts()).toBe(1);
    // Once it runs, health is the runner's (HealthyBusy keeps the microVM alive while it drains).
    expect(await (await fetch(`${base}/ping`)).json()).toEqual({ status: 'HealthyBusy' });
  });

  it('reports the runner stopping', async () => {
    const { base, exits } = await start();
    await fetch(`${base}/invocations`, { method: 'POST', body: 'exit' });
    for (let i = 0; i < 100 && !exits.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exits).toEqual([3]);
  });

  it('answers 503 when the runner never comes up', async () => {
    const { base, exits } = await start('process.exit(2)');
    const res = await fetch(`${base}/invocations`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(503);
    expect(exits).toEqual([2]);
  });
});
