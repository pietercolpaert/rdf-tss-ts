/**
 * Builds the playground into _site/: the bundle of playground/app.ts (the library included),
 * its lazily loaded chunks (Arrow, Parquet, eyemind), and the static files. The examples
 * are written by `npm run examples`.
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, '_site');
await mkdir(site, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'playground', 'app.ts')],
  outdir: site,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  chunkNames: 'chunks/[name]-[hash]',
  // the Node parts of the library (local files, locks) are only reached in Node
  external: ['node:*'],
  // eyemind keeps its QUDT profile out of its exports: the command line entry has it
  alias: { 'eyemind-cli': join(root, 'node_modules', 'eyemind', 'src', 'cli.js') },
  define: { global: 'globalThis' },
  logLevel: 'info',
});

for (const file of ['index.html', 'style.css', 'favicon.svg']) await copyFile(join(root, 'playground', file), join(site, file));
await writeFile(join(site, '.nojekyll'), '');
console.log(`built the playground in ${site}`);
