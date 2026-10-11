import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLauncher, warmUp } from './launcher.ts';

/**
 * The image's entry point (see launcher.ts). Next to it in the image:
 * runner.mjs, the bundled runner.
 *
 * No SIGTERM handler, on purpose: as PID 1 the launcher then ignores it, like
 * the runner did before it, and a draining turn goes on until AgentCore's SIGKILL.
 */
const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.mjs');
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

// Load the runner and start the Claude CLI once, in processes that are all gone
// before the launcher reports healthy: their files are read before the snapshot
// instead of on the first turn. An optimisation only, so a failure is logged.
const started = Date.now();
const outcome = await warmUp(process.execPath, [runnerPath], { ...process.env, WASP_WARM_UP: '1' }, 90_000);
log(`wasp launcher: warm-up ${outcome} in ${Date.now() - started} ms`);

const server = createLauncher({
  startRunner: () => spawn(process.execPath, [runnerPath], { env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }),
  onRunnerExit: (code) => {
    log(`wasp launcher: the runner exited (${code}), stopping`);
    process.exit(code ?? 1);
  },
  log
});

const port = Number(process.env.PORT ?? '8080');
server.listen(port, '0.0.0.0', () => log(`wasp launcher listening on :${port}`));
