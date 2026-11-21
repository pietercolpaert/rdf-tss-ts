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
  // the worker is its own entry: the playground starts it by its file name
  entryPoints: [join(root, 'playground', 'app.ts'), join(root, 'playground', 'matrixprofile.worker.ts')],
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
  external: ['node:fs', 'node:fs/promises', 'node:path', 'node:os', 'node:crypto', 'node:child_process', 'node:module'],
  // eyemind keeps its QUDT profile and its reasoner over messages out of its exports: they are in its source
  alias: {
    'eyemind-cli': join(root, 'node_modules', 'eyemind', 'src', 'cli.js'),
    'eyemind-formats': join(root, 'node_modules', 'eyemind', 'src', 'formats.js'),
    'eyemind-messages': join(root, 'node_modules', 'eyemind', 'src', 'messages.js'),
    'eyemind-rdf': join(root, 'node_modules', 'eyemind', 'src', 'rdf.js'),
    // ldfetch (and the RDF parsers it loads) expect Node's core modules
    http: 'stream-http',
    https: 'https-browserify',
    stream: 'stream-browserify',
    'node:url': 'url',
  },
  // ... and the `process` and `Buffer` globals
  inject: [join(root, 'scripts', 'shims', 'process.js'), join(root, 'scripts', 'shims', 'buffer.js')],
  define: { global: 'globalThis' },
  logLevel: 'info',
});

for (const file of ['index.html', 'style.css', 'favicon.svg', 'qudt-units.json']) await copyFile(join(root, 'playground', file), join(site, file));
await writeFile(join(site, '.nojekyll'), '');
console.log(`built the playground in ${site}`);
