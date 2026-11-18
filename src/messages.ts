import { DCTERMS, QUDT, RDF, SOSA, TSS, xsd } from './ns.js';
import type { Dataset, Quad, Term } from './rdf.js';
import { blankNode, literal, namedNode, quad, serializeRdf } from './rdf.js';
import type { Reading, Value } from './reading.js';
import type { ReadableSnippet } from './readable.js';
import type { FieldMetadata, RDFMessage } from './types.js';

export interface ObservationContext {
  reading: Reading;
  field: FieldMetadata;
  /** The value as read: with the unit it has after any conversion. */
  value: Value;
  snippet: ReadableSnippet;
}

/** Writes the observation of one value as quads, in the vocabulary of your choice. */
export type ObservationMapper = (context: ObservationContext) => Quad[];

/** The informative mapping of spec § 8.1: SOSA, QUDT and Dublin Core. */
export const sosaMapper: ObservationMapper = ({ reading, field, value, snippet }) => {
  const observation = blankNode();
  const out: Quad[] = [];
  const add = (predicate: string, object: Term) => out.push(quad(observation, namedNode(predicate), object as never));
  add(RDF + 'type', namedNode(SOSA + 'Observation'));
  add(DCTERMS + 'source', namedNode(snippet.id));
  add(SOSA + 'observedProperty', namedNode(field.observedProperty!));
  if (field.sensor) add(SOSA + 'madeBySensor', namedNode(field.sensor));
  if (field.featureOfInterest) add(SOSA + 'hasFeatureOfInterest', namedNode(field.featureOfInterest));
  if (value.unit) add(QUDT + 'hasUnit', namedNode(value.unit));
  add(SOSA + 'resultTime', literal(reading.time, namedNode(xsd('dateTime'))));
  add(SOSA + 'hasSimpleResult', field.language ? literal(value.value, field.language) : literal(value.value, namedNode(value.datatype)));
  return out;
};

export interface ToRDFMessagesOptions {
  /** `'sosa'` (default) or your own mapper. */
  mapping?: 'sosa' | ObservationMapper;
  /**
   * The description in the metadata of the IRIs the observations use (observed
   * properties, sensors, …), without TSS terms: in the first message (default), in every
   * message, or not at all.
   */
  description?: 'first' | 'every' | 'none';
}

/** The concise bounded description of a term, without the statements that use the TSS vocabulary. */
function describe(ds: Dataset, term: Term, out: Quad[], seen: Set<string>): void {
  const key = `${term.termType}:${term.value}`;
  if (seen.has(key)) return;
  seen.add(key);
  for (const q of ds.match(term as never, null, null, null)) {
    if (q.predicate.value.startsWith(TSS)) continue;
    if (q.predicate.value === RDF + 'type' && q.object.value.startsWith(TSS)) continue;
    out.push(q);
    if (q.object.termType === 'BlankNode') describe(ds, q.object, out, seen);
  }
}

function descriptionOf(snippet: ReadableSnippet): Quad[] {
  const iris = new Set<string>();
  for (const f of snippet.metadata.fields) {
    if (!f.observedProperty) continue;
    for (const iri of [f.observedProperty, f.sensor, f.featureOfInterest, f.unit]) if (iri) iris.add(iri);
  }
  const out: Quad[] = [];
  const seen = new Set<string>();
  for (const iri of iris) describe(snippet.dataset, namedNode(iri), out, seen);
  return out;
}

function message(quads: Quad[]): RDFMessage {
  return { quads, serialize: (mediaType = 'text/turtle', prefixes) => serializeRdf(quads, mediaType, prefixes) };
}

/**
 * Turn readings into RDF Messages: one message per reading, with one observation for every
 * value of a measured field (a field with `tss:observedProperty`).
 */
export async function* toRDFMessages(readings: AsyncIterable<Reading>, options: ToRDFMessagesOptions = {}): AsyncGenerator<RDFMessage> {
  const mapper = options.mapping === undefined || options.mapping === 'sosa' ? sosaMapper : options.mapping;
  const description = options.description ?? 'first';
  const described = new Set<string>();
  const cache = new Map<string, Quad[]>();
  for await (const reading of readings) {
    const snippet = reading.snippet;
    const quads: Quad[] = [];
    for (const [id, value] of reading.fields()) {
      const field = snippet.resolveField(id);
      if (!field.observedProperty) continue;
      quads.push(...mapper({ reading, field, value, snippet }));
    }
    if (quads.length === 0) continue;
    if (description === 'every' || (description === 'first' && !described.has(snippet.id))) {
      let extra = cache.get(snippet.id);
      if (!extra) cache.set(snippet.id, (extra = descriptionOf(snippet)));
      quads.push(...extra);
      described.add(snippet.id);
    }
    yield message(quads);
  }
}
