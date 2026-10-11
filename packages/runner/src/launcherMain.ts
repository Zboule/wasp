import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLauncher } from './launcher.ts';

/**
 * The image's entry point (see launcher.ts). Next to it in the image:
 * runner.mjs, the bundled runner.
 */
const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.mjs');
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

// Load the runner and start the Claude CLI once, in a process that then exits:
// their files are read before the snapshot instead of on the first turn. An
// optimisation only, so a failure is logged and the launcher goes on.
const started = Date.now();
const warm = spawnSync(process.execPath, [runnerPath], { env: { ...process.env, WASP_WARM_UP: '1' }, stdio: 'inherit', timeout: 90_000 });
log(`wasp launcher: warm-up ${warm.status === 0 ? 'done' : `failed (${warm.error?.message ?? `exit ${warm.status}`})`} in ${Date.now() - started} ms`);

const launcher = createLauncher({
  startRunner: () => spawn(process.execPath, [runnerPath], { env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }),
  onRunnerExit: (code) => {
    log(`wasp launcher: the runner exited (${code}), stopping`);
    process.exit(code ?? 1);
  },
  log
});

// PID 1 gets no default signal handling: without this, a stop waits for SIGKILL.
process.on('SIGTERM', () => {
  launcher.stop();
  process.exit(0);
});

const port = Number(process.env.PORT ?? '8080');
launcher.server.listen(port, '0.0.0.0', () => log(`wasp launcher listening on :${port}`));
