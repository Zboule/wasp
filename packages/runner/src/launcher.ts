import type { ChildProcess } from 'node:child_process';
import { type IncomingMessage, type ServerResponse, createServer, request } from 'node:http';

export type LauncherOptions = {
  /** Starts the runner: a process that sends `{ port }` over IPC once it listens on 127.0.0.1. */
  startRunner: () => ChildProcess;
  /** The runner stopped: the microVM is no use without it. */
  onRunnerExit: (code: number | null) => void;
  log?: (message: string) => void;
};

/**
 * The image's first process: it warms the runner up, then starts the real one
 * only when the first invocation arrives, and forwards requests to it.
 *
 * Why a separate process: on platform V2, AgentCore snapshots the microVM once
 * the health check passes and restores that snapshot for every new session.
 * Whatever runs at that moment is cloned, random state included: two sessions
 * restored from one snapshot draw the same `crypto.randomUUID()` and the same
 * TLS secrets. The runner holds a thread's credentials and talks TLS, so it must
 * start after the restore, in its own microVM. This process holds no secret,
 * makes no outbound connection and uses no randomness, so being cloned is harmless.
 */
export function createLauncher(options: LauncherOptions) {
  const log = options.log ?? ((message: string) => console.log(`${new Date().toISOString()} ${message}`));
  let runner: Promise<number> | null = null;
  let child: ChildProcess | null = null;

  const startOnce = () =>
    (runner ??= new Promise<number>((resolve, reject) => {
      const started = Date.now();
      child = options.startRunner();
      child.once('message', (message: unknown) => {
        const port = (message as { port?: unknown } | null)?.port;
        if (typeof port !== 'number') return reject(new Error('the runner did not report its port'));
        log(`wasp launcher: runner ready in ${Date.now() - started} ms`);
        resolve(port);
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
    // Before the first invocation there is nothing to report but health; this is also what the snapshot is taken on.
    if (!runner && req.method === 'GET' && (req.url ?? '').split('?')[0] === '/ping') return json(res, 200, { status: 'Healthy' });
    startOnce().then(
      (port) => forward(req, res, port),
      (error: unknown) => json(res, 503, { error: error instanceof Error ? error.message : String(error) })
    );
  });

  return {
    server,
    /** Stops the runner, if it started (on SIGTERM). */
    stop: () => child?.kill('SIGTERM')
  };
}
