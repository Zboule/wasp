import { type ChildProcess, spawn } from 'node:child_process';
import { type IncomingMessage, type ServerResponse, createServer, request } from 'node:http';

/** What the runner sends its launcher once it listens on 127.0.0.1. */
export type RunnerReady = { port: number };

export type LauncherOptions = {
  /** Starts the runner, a process that sends `RunnerReady` over IPC. */
  startRunner: () => ChildProcess;
  /** The runner stopped: the microVM is no use without it. */
  onRunnerExit: (code: number | null) => void;
  log?: (message: string) => void;
};

/**
 * The image's first process: it serves health until the first invocation, then
 * starts the runner and forwards every request to it.
 *
 * Why a separate process: on platform V2, AgentCore snapshots the microVM on
 * the first healthy `/ping` and restores that snapshot for every new session.
 * Whatever runs at that moment is cloned, random state included: two sessions
 * restored from one snapshot draw the same `crypto.randomUUID()`, and the same
 * random bytes TLS keys are made of. The runner holds a thread's credentials
 * and talks TLS, so it must start after the restore, in its own microVM: only
 * an invocation starts it, and nothing before the snapshot is one. This process
 * keeps nothing, opens no outbound connection and draws no random number, so
 * being cloned is harmless.
 */
export function createLauncher(options: LauncherOptions) {
  const log = options.log ?? ((message: string) => console.log(`${new Date().toISOString()} ${message}`));
  let runner: Promise<number> | null = null;

  const startOnce = () =>
    (runner ??= new Promise<number>((resolve, reject) => {
      const started = Date.now();
      const child = options.startRunner();
      child.once('message', (message: RunnerReady) => {
        log(`wasp launcher: runner ready in ${Date.now() - started} ms`);
        resolve(message.port);
      });
      child.once('exit', (code) => {
        reject(new Error(`the runner exited (${code})`));
        options.onRunnerExit(code);
      });
    }));

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  function forward(req: IncomingMessage, res: ServerResponse, port: number) {
    const upstream = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', (error) => {
      log(`wasp launcher: forwarding failed: ${error.message}`);
      if (!res.headersSent) json(res, 502, { error: 'runner unavailable' });
      else res.end();
    });
    req.pipe(upstream);
  }

  const server = createServer((req, res) => {
    if (!runner) {
      const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
      if (route === 'GET /ping') return json(res, 200, { status: 'Healthy' });
      if (route !== 'POST /invocations') return json(res, 404, { error: 'not found' });
    }
    startOnce().then(
      (port) => forward(req, res, port),
      (error: unknown) => json(res, 503, { error: error instanceof Error ? error.message : String(error) })
    );
  });

  return server;
}

/**
 * Runs a warm-up command and returns once it is over, along with everything it
 * started: it runs as its own process group, which is killed when it exits or
 * times out, so no process of it can still be running when the snapshot is taken.
 */
export async function warmUp(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<'done' | 'failed' | 'timed out'> {
  const child = spawn(command, args, { env, stdio: 'inherit', detached: true });
  const outcome = await new Promise<'done' | 'failed' | 'timed out'>((resolve) => {
    const timer = setTimeout(() => resolve('timed out'), timeoutMs);
    child.once('error', () => resolve('failed'));
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'done' : 'failed');
    });
  });
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {
    // The whole group is already gone.
  }
  return outcome;
}
