import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLauncher, warmUp } from './launcher.ts';

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

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((done) => done()));

async function start(script = FAKE_RUNNER) {
  const runners: ChildProcess[] = [];
  const exits: (number | null)[] = [];
  const server = createLauncher({
    startRunner: () => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      runners.push(child);
      return child;
    },
    onRunnerExit: (code) => exits.push(code),
    log: () => undefined
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => (runners.forEach((r) => r.kill()), server.close()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, runners, exits };
}

const invoke = (base: string, body: string) =>
  fetch(`${base}/invocations`, { method: 'POST', body, headers: { 'x-amzn-bedrock-agentcore-runtime-session-id': 'thread-1' } });

describe('launcher', () => {
  it('answers health on its own until the first invocation, and starts nothing for any other request', async () => {
    const { base, runners } = await start();
    expect(await (await fetch(`${base}/ping`)).json()).toEqual({ status: 'Healthy' });
    expect((await fetch(`${base}/ping`, { method: 'HEAD' })).status).toBe(404);
    expect((await fetch(`${base}/ping/`)).status).toBe(404);
    expect((await fetch(`${base}/invocations`)).status).toBe(404);
    expect(runners).toEqual([]);
  });

  it('starts the runner on the first invocation, once, and forwards requests and answers as they are', async () => {
    const { base, runners } = await start();
    const [a, b] = await Promise.all([invoke(base, 'one'), invoke(base, 'two')]);
    expect(a.status).toBe(202);
    const [first, second] = [await a.json(), await b.json()];
    expect([first.body, second.body].sort()).toEqual(['one', 'two']);
    expect(first.session).toBe('thread-1');
    expect(first.pid).toBe(second.pid);
    expect(runners).toHaveLength(1);
    // Once it runs, health is the runner's (HealthyBusy keeps the microVM alive while it drains).
    expect(await (await fetch(`${base}/ping`)).json()).toEqual({ status: 'HealthyBusy' });
  });

  it('reports the runner stopping', async () => {
    const { base, exits } = await start();
    await invoke(base, 'exit');
    for (let i = 0; i < 100 && !exits.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exits).toEqual([3]);
  });

  it('answers 503 when the runner never comes up', async () => {
    const { base, exits } = await start('process.exit(2)');
    expect((await invoke(base, 'x')).status).toBe(503);
    expect(exits).toEqual([2]);
  });
});

describe('warmUp', () => {
  /** Whether a process is still alive. */
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('leaves nothing running: what the warm-up started is killed with it', async () => {
    // Like the runner's warm-up: starts a long-lived child (the CLI), then exits.
    const pidFile = path.join(mkdtempSync(path.join(tmpdir(), 'wasp-warm-test-')), 'pid');
    const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); process.exit(0);`;
    expect(await warmUp(process.execPath, ['-e', script], process.env, 5_000)).toBe('done');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(pid)).toBe(false);
  });

  it('gives up on a warm-up that does not finish, and kills it', async () => {
    expect(await warmUp(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, 100)).toBe('timed out');
  });
});
