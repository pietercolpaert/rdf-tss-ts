/**
 * The alignment of the points of a source with SOSA, QUDT and SAREF, derived by a reasoner
 * from the TSS vocabulary of the specification: `tss:Point` is a `sosa:Observation` and a
 * `saref:Measurement`, `tss:time` and `tss:value` are subproperties of their properties, and
 * property chains over `tss:field` carry the observed property, sensor, feature of interest and
 * unit of a value field to each of its points. Nothing of this is written out here: eyemind
 * derives it with its OWL 2 RL profile, with the vocabulary and the description of the source
 * as background, reasoning over the rows as RDF Messages.
 *
 * The rules are specialized with two SHACL shapes that eyemind trusts: the shape of the points
 * of a row message (`tss:field`, `tss:time`, `tss:value`), and the shape of the observations
 * asked for. So the background is closed once, and every row costs little.
 */
import { Parser, Writer } from 'n3';
import { RDF, tss } from './ns.js';
import type { Quad, Term } from './rdf.js';
import { blankNode, literal, namedNode, quad } from './rdf.js';
import { isNode } from './platform.js';
import { TSS_VOCABULARY } from './vocabulary.js';

export type Alignment = 'sosa' | 'saref';

/** A quad as eyemind holds it. */
type EyemindQuad = unknown[];

/** The parts of eyemind this library uses: they are not exported by its package, but are in its source. */
export interface EyemindReasoning {
  /** `src/formats.js`: a reasoner over messages, with a background closed once. */
  loadMessageReasoner(
    inputs: [string, string][],
    io: null,
    options: { owl2rl: boolean; shaclIn: [string, string][]; shaclOut: [string, string][]; limits: Record<string, number> },
  ): { infer(quads: EyemindQuad[], limits?: Record<string, number>): { quads: EyemindQuad[] } };
  /** `src/messages.js`: the messages of an RDF Message Log, as quads of eyemind. */
  parseRdfMessages(text: string, options?: { format?: string }): { messages: { quads: EyemindQuad[] }[] };
  /** `src/rdf.js`: quads of eyemind as RDF. */
  writeRdf(quads: EyemindQuad[], options?: { format?: string }): string;
}

/** Derives the alignment of the points of one source, row by row. */
export interface Aligner {
  /** The triples a reasoner derives for these points (the quads of one row message), in the alignments asked for. */
  align(points: Quad[]): Quad[];
}

export interface AlignerOptions {
  /** The modules of eyemind that reason over messages. Default: loaded from the installed package in Node; in the browser, pass them. */
  eyemind?: EyemindReasoning;
}

/** Turtle assets are shipped beside this module, in Node and in the playground. */
const INPUT_SHAPE = new URL('./shapes/rdf-tss-in.ttl', import.meta.url);
const OUTPUT_SHAPES: Record<Alignment, URL> = {
  sosa: new URL('./shapes/sosa-out.ttl', import.meta.url),
  saref: new URL('./shapes/saref-out.ttl', import.meta.url),
};

const shapeTexts = new Map<string, Promise<string>>();

/** Load each shape only when needed, once per module instance. */
function loadShape(url: URL): Promise<string> {
  let text = shapeTexts.get(url.href);
  if (!text) {
    text = (async () => {
      if (isNode) {
        const { readFile } = await import('node:fs/promises');
        return readFile(url, 'utf8');
      }
      const response = await fetch(url);
      if (!response.ok) throw new Error(`loading SHACL shape ${url.href}: HTTP ${response.status}`);
      return response.text();
    })();
    shapeTexts.set(url.href, text);
    // A transient fetch failure should not prevent a later attempt.
    void text.catch(() => shapeTexts.delete(url.href));
  }
  return text;
}

/** The limits of the compiled programs of eyemind, as its command line sets them. */
const LIMITS = { maxDepth: 1_000_000, maxIterations: 100_000, maxInferences: 1_000_000_000 };

let defaults: Promise<EyemindReasoning> | undefined;

/** The modules of eyemind, from the installed package (Node only): its package exports only part of them. */
async function loadEyemind(): Promise<EyemindReasoning> {
  if (!isNode) {
    throw new Error("in the browser, pass eyemind's modules that reason over messages: expand({ align, aligner: { eyemind } })");
  }
  try {
    const { createRequire } = await import('node:module');
    const { dirname, join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const dir = dirname(createRequire(import.meta.url).resolve('eyemind/package.json'));
    const module = (file: string) => import(/* @vite-ignore */ pathToFileURL(join(dir, 'src', file)).href);
    const [formats, messages, rdf] = await Promise.all([module('formats.js'), module('messages.js'), module('rdf.js')]);
    return { loadMessageReasoner: formats.loadMessageReasoner, parseRdfMessages: messages.parseRdfMessages, writeRdf: rdf.writeRdf };
  } catch (error) {
    throw new Error(`the alignment needs the eyemind package (npm install eyemind): ${(error as Error).message}`);
  }
}

/** A point that is a blank node gets this IRI while it is reasoned over, so the output says which point it is about. */
const SKOLEM = 'urn:tss:point:';

/** The terms of the output of the reasoner, as terms of this library. */
function own(term: Term): Term {
  if (term.termType === 'NamedNode') return term.value.startsWith(SKOLEM) ? blankNode(term.value.slice(SKOLEM.length)) : namedNode(term.value);
  if (term.termType === 'BlankNode') return blankNode(term.value);
  if (term.termType === 'Literal') {
    const l = term as Term & { language?: string; datatype?: { value: string } };
    return l.language ? literal(l.value, l.language) : literal(l.value, namedNode(l.datatype?.value ?? 'http://www.w3.org/2001/XMLSchema#string'));
  }
  return term;
}

const nTriples = (quads: Quad[]) => new Writer({ format: 'N-Triples' }).quadsToString(quads);

/**
 * An aligner for the points of a source: eyemind with its OWL 2 RL profile, with the TSS
 * vocabulary and `description` (the quads of the description message of the source) as
 * background.
 */
export async function createAligner(description: Quad[], alignments: Alignment[], options: AlignerOptions = {}): Promise<Aligner> {
  const eyemind = options.eyemind ?? (await (defaults ??= loadEyemind()));
  const outputUrls = alignments.map((a) => OUTPUT_SHAPES[a]);
  const [input, ...outputs] = await Promise.all([INPUT_SHAPE, ...outputUrls].map(loadShape));
  const reasoner = eyemind.loadMessageReasoner(
    [
      [TSS_VOCABULARY, 'tss.ttl'],
      [nTriples(description), 'description.nt'],
    ],
    null,
    {
      owl2rl: true,
      shaclIn: [[input, 'rdf-tss-in.ttl']],
      shaclOut: outputs.map((text, i) => [text, outputUrls[i].pathname.split('/').pop()!]),
      limits: LIMITS,
    },
  );
  // The same Turtle files also determine which derived triples are returned.
  const outputQuads = outputs.flatMap((text) => new Parser({ format: 'Turtle' }).parse(text));
  const sh = 'http://www.w3.org/ns/shacl#';
  const classes = new Set(outputQuads.filter((q) => q.predicate.value === sh + 'targetClass').map((q) => q.object.value));
  const properties = new Set(outputQuads.filter((q) => q.predicate.value === sh + 'path').map((q) => q.object.value));
  return {
    align(points: Quad[]): Quad[] {
      const skolem = (t: Term) => (t.termType === 'BlankNode' ? namedNode(SKOLEM + t.value) : t);
      const message = points.map((q) => quad(skolem(q.subject) as never, q.predicate as never, skolem(q.object) as never));
      const nodes = new Set(message.filter((q) => q.predicate.value === tss('hasPoint')).map((q) => q.object.value));
      const [parsed] = eyemind.parseRdfMessages(`VERSION "1.2-messages"\n${nTriples(message)}`, { format: 'trig' }).messages;
      const result = reasoner.infer(parsed?.quads ?? [], LIMITS);
      const derived = new Parser({ format: 'N-Triples' }).parse(eyemind.writeRdf(result.quads, { format: 'n-triples' }));
      const out: Quad[] = [];
      const seen = new Set<string>();
      for (const q of derived) {
        // only what was asked for, about the points of the row
        if (!nodes.has(q.subject.value)) continue;
        const wanted = q.predicate.value === RDF + 'type' ? classes.has(q.object.value) : properties.has(q.predicate.value);
        if (!wanted) continue;
        const key = `${q.subject.value} ${q.predicate.value} ${q.object.termType}:${q.object.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(quad(own(q.subject) as never, own(q.predicate) as never, own(q.object) as never));
      }
      return out;
    },
  };
}
