// Bundles the image's two entry points into `outDir`: runner.mjs (the engine;
// the Agent SDK stays external, installed in the image for its per-platform
// `claude` binary) and launcher.mjs (the image's first process, see src/launcher.ts).
// Used by this package's `build` and by @zboule/wasp-infra's assets script.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning' };

export async function bundleImage(outDir) {
  await build({
    ...common,
    entryPoints: [path.join(src, 'main.ts')],
    outfile: path.join(outDir, 'runner.mjs'),
    external: ['@anthropic-ai/claude-agent-sdk'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
  });
  await build({ ...common, entryPoints: [path.join(src, 'launcherMain.ts')], outfile: path.join(outDir, 'launcher.mjs') });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundleImage(process.argv[2] ?? 'image');
