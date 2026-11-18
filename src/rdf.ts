import { DataFactory, Parser, Store, Writer } from 'n3';
import type { BlankNode, DatasetCore, Literal, NamedNode, Quad, Term } from '@rdfjs/types';

export type Dataset = DatasetCore;
export type { BlankNode, Literal, NamedNode, Quad, Term };

export const { namedNode, literal, blankNode, quad, defaultGraph } = DataFactory;

export type RdfFormat = 'turtle' | 'trig' | 'n-triples' | 'n-quads' | 'jsonld';

const MEDIA_TYPES: Record<string, RdfFormat> = {
  'text/turtle': 'turtle',
  'application/x-turtle': 'turtle',
  'application/trig': 'trig',
  'application/n-triples': 'n-triples',
  'text/plain': 'n-triples',
  'application/n-quads': 'n-quads',
  'application/ld+json': 'jsonld',
  'application/json': 'jsonld',
};

const EXTENSIONS: Record<string, RdfFormat> = {
  ttl: 'turtle',
  trig: 'trig',
  nt: 'n-triples',
  nq: 'n-quads',
  jsonld: 'jsonld',
  json: 'jsonld',
};

/** Pick an RDF syntax from a media type, or else from a file name or URL; Turtle by default. */
export function rdfFormatFor(hint: { contentType?: string | null; filename?: string }): RdfFormat {
  const type = hint.contentType?.split(';')[0].trim().toLowerCase();
  if (type && MEDIA_TYPES[type]) return MEDIA_TYPES[type];
  const path = hint.filename?.split(/[?#]/)[0] ?? '';
  const extension = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
  return EXTENSIONS[extension] ?? 'turtle';
}

const N3_FORMATS: Record<Exclude<RdfFormat, 'jsonld'>, string> = {
  turtle: 'text/turtle',
  trig: 'application/trig',
  'n-triples': 'application/n-triples',
  'n-quads': 'application/n-quads',
};

/** Whether a Turtle or TriG document announces itself as an RDF Message Log (`@version "1.2-messages"`). */
export function isMessageLog(text: string): boolean {
  return /^\s*(?:#[^\n]*\n\s*)*(?:@version|VERSION)\s+"[^"]*-messages"/i.test(text.slice(0, 2000));
}

/** Parse an RDF document into a store. An RDF Message Log is read as the merge of its messages. */
export async function parseRdf(
  text: string,
  options: { contentType?: string | null; filename?: string; baseIRI?: string } = {},
): Promise<Store> {
  const format = rdfFormatFor(options);
  if (format === 'jsonld') {
    const { JsonLdParser } = await import('jsonld-streaming-parser');
    return new Promise<Store>((resolve, reject) => {
      const parser = new JsonLdParser({ baseIRI: options.baseIRI });
      const quads: Quad[] = [];
      parser.on('data', (q: Quad) => quads.push(q));
      parser.on('error', reject);
      parser.on('end', () => resolve(new Store(quads)));
      parser.write(text);
      parser.end();
    });
  }
  if (isMessageLog(text)) {
    const { parseMessages } = await import('n3.js-messages');
    const messages = parseMessages(text, { format: N3_FORMATS[format], baseIRI: options.baseIRI });
    return new Store(messages.flat());
  }
  const parser = new Parser({ format: N3_FORMATS[format], baseIRI: options.baseIRI });
  return new Store(parser.parse(text));
}

/** Parse the messages of an RDF Message Log, with the prefixes of the log in force; `messages: true` for a log without a version line. */
export async function parseLogMessages(text: string, options: { baseIRI?: string } = {}): Promise<Quad[][]> {
  const { parseMessages } = await import('n3.js-messages');
  return parseMessages(text, { format: 'TriG', baseIRI: options.baseIRI, messages: true }) as Quad[][];
}

/** Write messages as a Turtle RDF Message Log: the version label, the prefixes, and `@message .` after each message. */
export async function serializeMessages(messages: Quad[][], prefixes: Record<string, string> = {}): Promise<string> {
  const { writeMessages } = await import('n3.js-messages');
  return writeMessages(messages, { format: 'Turtle', prefixes });
}

/** The same messages without the version label and the prefixes, to append them to an existing log that declares them. */
export async function serializeMessagesTail(messages: Quad[][], prefixes: Record<string, string> = {}): Promise<string> {
  const text = await serializeMessages(messages, prefixes);
  return text.replace(/^@version[^\n]*\n(?:@(?:prefix|base)[^\n]*\n)*\n?/, '');
}

/** Serialize quads as Turtle, TriG, N-Triples, N-Quads or JSON-LD. */
export async function serializeRdf(
  quads: Iterable<Quad>,
  mediaType = 'text/turtle',
  prefixes: Record<string, string> = {},
): Promise<string> {
  const format = rdfFormatFor({ contentType: mediaType });
  if (format === 'jsonld') {
    const { JsonLdSerializer } = await import('jsonld-streaming-serializer');
    return new Promise<string>((resolve, reject) => {
      const serializer = new JsonLdSerializer({ space: '  ' });
      let out = '';
      serializer.on('data', (chunk: string | Buffer) => (out += chunk.toString()));
      serializer.on('error', reject);
      serializer.on('end', () => resolve(out));
      for (const q of quads) serializer.write(q);
      serializer.end();
    });
  }
  const writer = new Writer({ format: N3_FORMATS[format], prefixes });
  const list = [...quads];
  if ((format === 'turtle' || format === 'trig') && list.every((q) => q.graph.termType === 'DefaultGraph')) {
    addNested(writer, list);
  } else {
    for (const q of list) writer.addQuad(q);
  }
  return new Promise<string>((resolve, reject) => writer.end((error, result) => (error ? reject(error) : resolve(result as string))));
}

/**
 * Add quads to a writer with blank nodes that are mentioned once written inline, as
 * `[ … ]`: the stored summaries and the embedded points then take few bytes and stay readable.
 */
function addNested(writer: Writer, quads: Quad[]): void {
  const bySubject = new Map<string, Quad[]>();
  const incoming = new Map<string, number>();
  for (const q of quads) {
    const key = `${q.subject.termType}:${q.subject.value}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), q]);
    if (q.object.termType === 'BlankNode') incoming.set(q.object.value, (incoming.get(q.object.value) ?? 0) + 1);
  }
  const inlined = new Set<string>();
  const canInline = (term: Term) => term.termType === 'BlankNode' && incoming.get(term.value) === 1 && bySubject.has(`BlankNode:${term.value}`);
  const inline = (node: Term, stack: string[]): Term => {
    inlined.add(node.value);
    const own = bySubject.get(`BlankNode:${node.value}`) ?? [];
    return writer.blank(
      own.map((q) => ({
        predicate: q.predicate as never,
        object: (canInline(q.object) && !stack.includes(q.object.value) ? inline(q.object, [...stack, node.value]) : q.object) as never,
      })),
    );
  };
  const emitted = new Set<string>();
  const emit = (subjectKey: string) => {
    emitted.add(subjectKey);
    for (const q of bySubject.get(subjectKey)!) {
      const object = canInline(q.object) && !inlined.has(q.object.value) ? inline(q.object, []) : q.object;
      writer.addQuad(q.subject as never, q.predicate as never, object as never);
    }
  };
  for (const [key, own] of bySubject) {
    if (own[0].subject.termType === 'BlankNode' && canInline(own[0].subject)) continue;
    emit(key);
  }
  // blank nodes in a cycle are not reachable from a named subject
  for (const [key, own] of bySubject) {
    if (!emitted.has(key) && !inlined.has(own[0].subject.value)) emit(key);
  }
}

/** The objects of a subject and predicate. */
export function objectsOf(ds: Dataset, subject: Term, predicate: string): Term[] {
  const out: Term[] = [];
  for (const q of ds.match(subject, namedNode(predicate), null, null)) out.push(q.object);
  return out;
}

export function objectOf(ds: Dataset, subject: Term, predicate: string): Term | undefined {
  for (const q of ds.match(subject, namedNode(predicate), null, null)) return q.object;
  return undefined;
}

export function subjectsOf(ds: Dataset, predicate: string, object: Term | null): Term[] {
  const out: Term[] = [];
  for (const q of ds.match(null, namedNode(predicate), object, null)) out.push(q.subject);
  return out;
}

/** The identifier used for a term in the API: the IRI, or `_:label` for a blank node. */
export function termId(term: Term): string {
  return term.termType === 'BlankNode' ? `_:${term.value}` : term.value;
}

export function sameTerm(a: Term, b: Term): boolean {
  return a.termType === b.termType && a.value === b.value;
}
