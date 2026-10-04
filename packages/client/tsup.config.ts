import { defineConfig } from 'tsup';

// The store is internal: bundled into the client, its types inlined.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  clean: true,
  dts: { resolve: ['@zboule/wasp-store'] },
  external: ['@zboule/wasp-protocol'],
  noExternal: ['@zboule/wasp-store']
});
