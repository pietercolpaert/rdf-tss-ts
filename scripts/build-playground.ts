/**
 * Builds the playground into _site/: the bundle of playground/app.ts (the library included),
 * its lazily loaded chunks (Arrow, Parquet, eyemind, rdfjs-inference-engine), and the static files. The examples
 * are written by `npm run examples`.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The engine's directory: its package.json is not exported. */
const engineDir = (() => {
  let dir = dirname(createRequire(import.meta.url).resolve('rdfjs-inference-engine'));
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
})();

/** rdfjs-inference-engine imports node:fs, node:path and node:stream: in the browser, stand-ins. */
const engineShims: esbuild.Plugin = {
  name: 'engine-shims',
  setup(build) {
    const shims: Record<string, string> = {
      'node:fs': join(root, 'scripts', 'shims', 'node-fs.js'),
      'node:path': join(root, 'scripts', 'shims', 'node-path.js'),
    };
    build.onResolve({ filter: /^node:(fs|path|stream)$/ }, (args) => {
      if (!/rdfjs-inference-engine|eyeling/.test(args.importer)) return undefined;
      if (args.path === 'node:stream') return build.resolve('stream-browserify', { kind: args.kind, resolveDir: root });
      return { path: shims[args.path] };
    });
  },
};
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
  // eyemind keeps its QUDT profile out of its exports: the command line entry has it
  alias: {
    'eyemind-cli': join(root, 'node_modules', 'eyemind', 'src', 'cli.js'),
    // the OWL 2 RL rules of rdfjs-inference-engine, as text: the reasoner of the alignment
    'owl2rl-rules': join(engineDir, 'rules', 'owl2rl', 'owl2rl-eyeling.n3'),
    // ldfetch (and the RDF parsers it loads) expect Node's core modules
    http: 'stream-http',
    https: 'https-browserify',
    stream: 'stream-browserify',
    'node:url': 'url',
  },
  // ... and the `process` and `Buffer` globals
  inject: [join(root, 'scripts', 'shims', 'process.js'), join(root, 'scripts', 'shims', 'buffer.js')],
  define: { global: 'globalThis' },
  loader: { '.n3': 'text' },
  plugins: [engineShims],
  logLevel: 'info',
});

for (const file of ['index.html', 'style.css', 'favicon.svg']) await copyFile(join(root, 'playground', file), join(site, file));
await writeFile(join(site, '.nojekyll'), '');
console.log(`built the playground in ${site}`);
