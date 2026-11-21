/** Copy the SHACL Turtle assets alongside the compiled library. */
import { cp } from 'node:fs/promises';

await cp(
  new URL('../src/shapes/', import.meta.url),
  new URL('../dist/shapes/', import.meta.url),
  { recursive: true },
);
