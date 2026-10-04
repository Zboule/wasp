// Builds what ships inside @zboule/wasp-infra besides its code:
//   image/              the runner image context (bundled engine, Dockerfile, the Agent SDK pin and its lockfile)
//   assets/waker/       the waker Lambda, one bundled file
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const runner = '../runner';
rmSync('image', { recursive: true, force: true });
rmSync('assets', { recursive: true, force: true });
mkdirSync('image/definition', { recursive: true });
mkdirSync('assets/waker', { recursive: true });

const requireShim = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";
await build({
  entryPoints: [`${runner}/src/main.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'image/runner.mjs',
  external: ['@anthropic-ai/claude-agent-sdk'],
  banner: { js: requireShim },
  logLevel: 'warning'
});
cpSync(`${runner}/image/Dockerfile`, 'image/Dockerfile');
cpSync(`${runner}/image/package.json`, 'image/package.json');
cpSync(`${runner}/image/package-lock.json`, 'image/package-lock.json');

await build({
  entryPoints: ['src/waker/handler.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'assets/waker/index.mjs',
  banner: { js: requireShim },
  logLevel: 'warning'
});
console.log('infra assets: image/ and assets/waker/ built');
