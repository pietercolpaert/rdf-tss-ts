/**
 * Builds the playground into _site/: the bundle of playground/app.ts (the library included),
 * its lazily loaded chunks (Arrow, Parquet, eyemind), and the static files. The examples
 * are written by `npm run examples`.
 */
import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const site = join(root, '_site');
await mkdir(site, { recursive: true });

const build = await esbuild.build({
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
  metafile: true,
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

// import.meta.url belongs to the emitted module (which can be a shared chunk).
// Keep the Turtle assets beside each output directory so the aligner can fetch them.
const moduleDirectories = new Set(Object.keys(build.metafile.outputs).filter((file) => file.endsWith('.js')).map((file) => dirname(resolve(file))));
await Promise.all([...moduleDirectories].map((dir) => cp(join(root, 'src', 'shapes'), join(dir, 'shapes'), { recursive: true })));

for (const file of ['index.html', 'style.css', 'favicon.svg', 'qudt-units.json']) await copyFile(join(root, 'playground', file), join(site, file));
await writeFile(join(site, '.nojekyll'), '');
console.log(`built the playground in ${site}`);
