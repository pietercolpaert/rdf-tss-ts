/**
 * The alignment of the points of a source with SOSA, QUDT and SAREF, derived by a reasoner
 * from the TSS vocabulary of the specification: `tss:Point` is a `sosa:Observation` and a
 * `saref:Measurement`, `tss:time` and `tss:value` are subproperties of their properties, and
 * property chains over `tss:field` carry the observed property, sensor, feature of interest and
 * unit of a value field to each of its points. Nothing of this is written out here: the
 * reasoner (rdfjs-inference-engine, with its OWL 2 RL rules for Eyeling) derives it, with the
 * vocabulary and the description of the source as background.
 *
 * The rules are specialized with two SHACL shapes that the reasoner trusts: the shape of the
 * points of a row message (`tss:field`, `tss:time`, `tss:value`), and the shape of the
 * observations asked for. So the background is closed once, and every row costs little.
 */
import { QUDT, RDF, SAREF, SOSA, tss } from './ns.js';
import type { Quad, Term } from './rdf.js';
import { blankNode, literal, namedNode, parseRdf, quad } from './rdf.js';
import { isNode } from './platform.js';
import { TSS_VOCABULARY } from './vocabulary.js';

export type Alignment = 'sosa' | 'saref';

/** The part of rdfjs-inference-engine this library uses. */
export interface InferenceEngineModule {
  InferenceEngine: new () => {
    load(profiles: { n3: string; label?: string }[], vocabulary: Iterable<Quad>, options?: { shaclIn?: string; shaclOut?: string }): unknown;
    infer(quads: Iterable<Quad>): Iterable<Quad>;
  };
}

/** Derives the alignment of the points of one source, row by row. */
export interface Aligner {
  /** The triples a reasoner derives for these points (the quads of one row message), in the alignments asked for. */
  align(points: Quad[]): Quad[];
}

export interface AlignerOptions {
  /** The rdfjs-inference-engine module. Default: imported in Node; in the browser, pass it. */
  engine?: InferenceEngineModule;
  /** The OWL 2 RL rules of rdfjs-inference-engine (rules/owl2rl/owl2rl-eyeling.n3). Default: read from the package in Node; in the browser, pass them. */
  owl2rl?: string;
}

/** The shape of the points of a row message: what the rules are specialized to. */
const SHAPES_IN = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix tss: <https://w3id.org/tss#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:tss:shapes#source> a sh:NodeShape ; sh:targetSubjectsOf tss:hasPoint ;
    sh:property [ sh:path tss:hasPoint ; sh:nodeKind sh:BlankNodeOrIRI ] .
<urn:tss:shapes#point> a sh:NodeShape ; sh:targetObjectsOf tss:hasPoint ;
    sh:property [ sh:path tss:field ; sh:nodeKind sh:IRI ] ,
        [ sh:path tss:time ; sh:nodeKind sh:Literal ] ,
        [ sh:path tss:value ; sh:nodeKind sh:Literal ] .
`;

/** What each alignment asks for: the class of a point, and the properties derived for it. */
const ASKED: Record<Alignment, { class: string; properties: string[] }> = {
  sosa: {
    class: SOSA + 'Observation',
    properties: [
      SOSA + 'resultTime',
      SOSA + 'hasSimpleResult',
      SOSA + 'observedProperty',
      SOSA + 'madeBySensor',
      SOSA + 'hasFeatureOfInterest',
      QUDT + 'hasUnit',
    ],
  },
  saref: {
    class: SAREF + 'Measurement',
    properties: [
      SAREF + 'hasTimestamp',
      SAREF + 'hasValue',
      SAREF + 'relatesToProperty',
      SAREF + 'measurementMadeBy',
      SAREF + 'isMeasurementOf',
      SAREF + 'isMeasuredIn',
    ],
  },
};

/** The shape of the observations asked for: only the rules that can derive these are kept. */
function shapesOut(alignments: Alignment[]): string {
  const shapes = alignments.map((a) => {
    const { class: cls, properties } = ASKED[a];
    const paths = [`[ sh:path <${RDF}type> ; sh:in ( <${cls}> ) ]`, ...properties.map((p) => `[ sh:path <${p}> ]`)];
    return `<urn:tss:shapes#${a}> a sh:NodeShape ; sh:targetClass <${cls}> ;\n    sh:property ${paths.join(' ,\n        ')} .`;
  });
  return `@prefix sh: <http://www.w3.org/ns/shacl#> .\n${shapes.join('\n')}\n`;
}

let vocabulary: Promise<Quad[]> | undefined;
const vocabularyQuads = () => (vocabulary ??= parseRdf(TSS_VOCABULARY, { contentType: 'text/turtle', baseIRI: 'https://w3id.org/tss' }).then((ds) => [...ds.match(null, null, null, null)]));

let defaults: Promise<Required<AlignerOptions>> | undefined;

/** rdfjs-inference-engine and its OWL 2 RL rules, from the installed package (Node only). */
async function loadDefaults(): Promise<Required<AlignerOptions>> {
  if (!isNode) {
    throw new Error('in the browser, pass rdfjs-inference-engine and its OWL 2 RL rules: expand({ align, aligner: { engine, owl2rl } })');
  }
  try {
    const { createRequire } = await import('node:module');
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const require = createRequire(import.meta.url);
    const engine = require('rdfjs-inference-engine') as InferenceEngineModule;
    // the package exports no package.json: its directory is found from its entry point
    let dir = dirname(require.resolve('rdfjs-inference-engine'));
    while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
    const owl2rl = await readFile(join(dir, 'rules', 'owl2rl', 'owl2rl-eyeling.n3'), 'utf8');
    return { engine, owl2rl };
  } catch (error) {
    throw new Error(`the alignment needs the rdfjs-inference-engine package (npm install rdfjs-inference-engine): ${(error as Error).message}`);
  }
}

/** The terms of the output of the reasoner, as terms of this library. */
function own(term: Term): Term {
  if (term.termType === 'NamedNode') return namedNode(term.value);
  if (term.termType === 'BlankNode') return blankNode(term.value);
  if (term.termType === 'Literal') {
    const l = term as Term & { language?: string; datatype?: { value: string } };
    return l.language ? literal(l.value, l.language) : literal(l.value, namedNode(l.datatype?.value ?? 'http://www.w3.org/2001/XMLSchema#string'));
  }
  return term;
}

/**
 * An aligner for the points of a source: the reasoner, loaded with the TSS vocabulary and
 * `description` (the quads of the description message of the source) as background.
 */
export async function createAligner(description: Quad[], alignments: Alignment[], options: AlignerOptions = {}): Promise<Aligner> {
  const { engine, owl2rl } = options.engine && options.owl2rl ? (options as Required<AlignerOptions>) : { ...(await (defaults ??= loadDefaults())), ...options };
  const reasoner = new engine.InferenceEngine();
  reasoner.load([{ n3: owl2rl, label: 'owl2rl' }], [...(await vocabularyQuads()), ...description], { shaclIn: SHAPES_IN, shaclOut: shapesOut(alignments) });
  const classes = new Set(alignments.map((a) => ASKED[a].class));
  const properties = new Set(alignments.flatMap((a) => ASKED[a].properties));
  return {
    align(points: Quad[]): Quad[] {
      const nodes = new Set(points.filter((q) => q.predicate.value === tss('hasPoint')).map((q) => `${q.object.termType}:${q.object.value}`));
      const out: Quad[] = [];
      const seen = new Set<string>();
      for (const q of reasoner.infer(points)) {
        // only what was asked for, about the points of the row
        if (!nodes.has(`${q.subject.termType}:${q.subject.value}`)) continue;
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
