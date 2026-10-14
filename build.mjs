// Build step: bundle the Bryntum Scheduler view and its themes into public/build/.
// `npm run build` (also run by `npm install`). Everything else in public/ is served as is.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'public', 'build');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const B = '@bryntum/scheduler';
const cssEntries = {
  'bryntum-light': [`${B}/fontawesome/css/fontawesome.css`, `${B}/fontawesome/css/solid.css`, `${B}/scheduler.css`, `${B}/stockholm-light.css`],
  'bryntum-dark': [`${B}/fontawesome/css/fontawesome.css`, `${B}/fontawesome/css/solid.css`, `${B}/scheduler.css`, `${B}/stockholm-dark.css`],
};
const tmp = path.join(root, 'src', 'client', '.css-entries');
fs.mkdirSync(tmp, { recursive: true });
const entryPoints = { timeline: path.join(root, 'src', 'client', 'timeline.js') };
for (const [name, imports] of Object.entries(cssEntries)) {
  const file = path.join(tmp, `${name}.css`);
  fs.writeFileSync(file, imports.map((i) => `@import '${i}';`).join('\n') + '\n');
  entryPoints[name] = file;
}

const t0 = Date.now();
const result = await build({
  entryPoints,
  outdir: out,
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  legalComments: 'eof',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.eot': 'file', '.svg': 'file' },
  assetNames: 'assets/[name]-[hash]',
  logLevel: 'warning',
  metafile: true,
});
fs.rmSync(tmp, { recursive: true, force: true });

const sizes = Object.entries(result.metafile.outputs)
  .filter(([f]) => !f.includes('/assets/'))
  .map(([f, o]) => `${path.basename(f)} ${(o.bytes / 1024).toFixed(0)} KB`);
console.log(`[build] public/build: ${sizes.join(', ')} (${Date.now() - t0} ms)`);
