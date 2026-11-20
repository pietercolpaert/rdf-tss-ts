/**
 * Copies the TSS vocabulary (tss.ttl) of the specification into src/vocabulary.ts, so the
 * library can reason with it, in Node and in the browser, without fetching it. Run it again
 * when the specification changes: `npm run vocabulary`.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The commit of the specification whose vocabulary is copied: pull request #37. */
const COMMIT = '99ee66e2bc6e1b0d9686b8d6be675bcf72bebc22';
const URL = `https://raw.githubusercontent.com/KNowledgeOnWebScale/rdf-tss/${COMMIT}/tss.ttl`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const response = await fetch(URL);
if (!response.ok) throw new Error(`${URL}: HTTP ${response.status}`);
const turtle = await response.text();
const source = `// Written by scripts/vocabulary.ts: do not edit.

/** Where the vocabulary was copied from: tss.ttl of the specification, at one commit. */
export const TSS_VOCABULARY_SOURCE = ${JSON.stringify(URL)};

/**
 * The TSS vocabulary (tss.ttl) of the specification, as Turtle. Among its terms are the
 * alignment of the points with SOSA, QUDT and SAREF: \`tss:Point\` is a \`sosa:Observation\`
 * and a \`saref:Measurement\`, \`tss:time\` and \`tss:value\` are subproperties of their
 * properties, and property chains over \`tss:field\` carry what a value field observes.
 */
export const TSS_VOCABULARY = ${JSON.stringify(turtle)};
`;
await writeFile(join(root, 'src', 'vocabulary.ts'), source);
console.log(`copied ${URL} (${turtle.length} characters) to src/vocabulary.ts`);
