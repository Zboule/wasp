// pnpm playground → http://localhost:5174
import * as esbuild from 'esbuild';

const ctx = await esbuild.context({
  entryPoints: {
    main: 'playground/main.tsx',
    styles: 'src/react/styles.css',
    shadcn: 'src/themes/shadcn.css',
    'shadcn-tokens': 'playground/shadcn-tokens.css',
    page: 'playground/page.css'
  },
  bundle: true,
  outdir: 'playground/out',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'info'
});
await ctx.watch();
const { port } = await ctx.serve({ servedir: 'playground', host: '127.0.0.1', port: Number(process.env.PORT ?? 5174) });
console.log(`wasp-ui playground: http://localhost:${port}`);
