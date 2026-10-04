// Build the embeddable IIFE bundle (React + core + component + CSS, self-contained).
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // repo root
// Optional argv: extra outfiles (absolute or cwd-relative) to copy the bundle to,
// e.g. `node react/build.js ../book-builder/public/wisp.js`
const outfile = path.join(root, "examples", "poc", "wisp.js");
const extraOutfiles = process.argv.slice(2).map((p) => path.resolve(p));

await esbuild.build({
  entryPoints: [path.join(root, "react", "src", "embed.jsx")],
  bundle: true,
  format: "iife",
  globalName: "Wisp",
  outfile,
  jsx: "automatic",
  loader: { ".css": "text" },
  minify: true,
  sourcemap: false,
  logLevel: "info",
});

import { copyFile } from "node:fs/promises";
for (const extra of extraOutfiles) {
  await copyFile(outfile, extra);
  console.log("copied →", extra);
}
console.log("built", path.relative(root, outfile));
