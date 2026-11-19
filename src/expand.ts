/**
 * Expanding a source into points (spec: "Expanding a source into points"): every value of a
 * value field becomes a point, in the shape of the points of a `tss:EmbeddedRDFSource`, linked
 * to its source with `tss:hasPoint` and to its field with `tss:field`.
 */
import { expandTemplate, resolveIri } from './iri.js';
import { propertyBase } from './metadata.js';
import { QUDT, RDF, RDFS, SAREF, SOSA, tss, xsd } from './ns.js';
import type { NamedNode, Quad, Term } from './rdf.js';
import { blankNode, literal, namedNode, quad, serializeRdf } from './rdf.js';
import type { ReadableSource } from './readable.js';
import type { Row, Value } from './row.js';
import type { FieldMetadata, RDFMessage } from './types.js';

export type Alignment = 'sosa' | 'saref';

export interface ExpandOptions {
  /**
   * Start with a message with the metadata of the source (without `tss:points`) and its default
   * field properties. Default `true`; `toRDFMessages` writes it once per source.
   */
  metadata?: boolean;
  /**
   * Also write, for each point, what a reasoner derives from the alignment of the TSS vocabulary
   * with SOSA (and QUDT) or SAREF: the point as an observation or measurement, with its result
   * time, result, observed property, sensor, feature of interest and unit. A value is only a
   * result when its field property is aligned: a default property, or one the metadata states to
   * be a subproperty of `tss:value`.
   */
  align?: Alignment | Alignment[];
}

function message(quads: Quad[]): RDFMessage {
  return { quads, serialize: (mediaType = 'text/turtle', prefixes) => serializeRdf(quads, mediaType, prefixes) };
}

const termOf = (id: string): NamedNode | Term => (id.startsWith('_:') ? blankNode(id.slice(2)) : namedNode(id));

interface Plan {
  source: Term;
  time: string;
  timeAligned: boolean;
  valueFields: (FieldMetadata & { property: string; aligned: boolean })[];
  /** The describing fields of each value field. */
  describers: Map<string, (FieldMetadata & { property: string })[]>;
  /** The variables of `tss:aboutUrl`: column name to field id (`''` for the time field). */
  variables: [string, string][];
  base?: string;
  align: Set<Alignment>;
}

const plans = new WeakMap<ReadableSource, Map<string, Plan>>();

function hasSubProperty(source: ReadableSource, property: string, of: string): boolean {
  if (property === of) return true;
  for (const _ of source.dataset.match(namedNode(property), namedNode(RDFS + 'subPropertyOf'), namedNode(of), null)) return true;
  return false;
}

function planOf(source: ReadableSource, align: Set<Alignment>): Plan {
  let bySource = plans.get(source);
  if (!bySource) plans.set(source, (bySource = new Map()));
  const meta = source.metadata;
  const key = `${meta.id} ${[...align].sort().join(',')} ${source.dataset.size ?? ''}`;
  const cached = bySource.get(key);
  if (cached) return cached;

  const timeField = meta.fields.find((f) => f.id === meta.timeField)!;
  const time = timeField.property ?? tss('time');
  const missing = (f: FieldMetadata) =>
    new Error(`field ${f.id} states no tss:property and its default property cannot be made: ${f.columnName === undefined ? 'it has no tss:columnName' : 'there is no base IRI'}`);
  const valueFields: Plan['valueFields'] = [];
  const describers: Plan['describers'] = new Map();
  for (const f of meta.fields) {
    if (f.kind !== 'value' || f.id === meta.timeField || f.id === meta.stepField) continue;
    if (!f.property) throw missing(f);
    valueFields.push({ ...f, property: f.property, aligned: f.defaultProperty || hasSubProperty(source, f.property, tss('value')) });
  }
  for (const f of meta.fields) {
    if (f.kind !== 'meta') continue;
    for (const target of f.describesField) {
      if (!f.property) throw missing(f);
      describers.set(target, [...(describers.get(target) ?? []), { ...f, property: f.property }]);
    }
  }
  const variables: [string, string][] = meta.fields.filter((f) => f.columnName !== undefined).map((f) => [f.columnName!, f.id === meta.timeField ? '' : f.id]);
  const plan: Plan = {
    source: source.node,
    time,
    timeAligned: hasSubProperty(source, time, tss('time')),
    valueFields,
    describers,
    variables,
    base: propertyBase(meta, source.baseIRI),
    align,
  };
  bySource.set(key, plan);
  return plan;
}

const alignmentsOf = (options: ExpandOptions) => new Set(options.align === undefined ? [] : Array.isArray(options.align) ? options.align : [options.align]);

/**
 * The first message of the expansion: the metadata document without `tss:points` and without
 * the embedded points (they follow, one row per message), and, for each field without a
 * `tss:property`, its default property; for a value field, also that this property is a
 * subproperty of `tss:value`.
 */
export function expansionHead(source: ReadableSource, _options: ExpandOptions = {}): RDFMessage {
  const ds = source.dataset;
  const pointNodes = new Set<string>();
  for (const q of ds.match(null, namedNode(tss('hasPoint')), null, null)) pointNodes.add(`${q.object.termType}:${q.object.value}`);
  const out: Quad[] = [];
  for (const q of ds.match(null, null, null, null)) {
    if (q.predicate.value === tss('points') || q.predicate.value === tss('hasPoint')) continue;
    if (pointNodes.has(`${q.subject.termType}:${q.subject.value}`)) continue;
    out.push(q);
  }
  for (const f of source.metadata.fields) {
    if (!f.defaultProperty || !f.property) continue;
    out.push(quad(termOf(f.id) as NamedNode, namedNode(tss('property')), namedNode(f.property)));
    if (f.kind === 'value' && f.id !== source.metadata.timeField) {
      out.push(quad(namedNode(f.property), namedNode(RDFS + 'subPropertyOf'), namedNode(tss('value'))));
    }
  }
  return message(out);
}

function valueLiteral(f: FieldMetadata, value: Value) {
  return f.language ? literal(value.value, f.language) : literal(value.value, namedNode(f.datatype));
}

/** The points of one row, as quads. */
export function pointsOfRow(row: Row, options: ExpandOptions = {}): Quad[] {
  const plan = planOf(row.source, alignmentsOf(options));
  const values = new Map(row.fields());
  const out: Quad[] = [];
  const timeLiteral = literal(row.time, namedNode(xsd('dateTimeStamp')));
  let variables: Record<string, string | undefined> | undefined;
  for (const f of plan.valueFields) {
    const value = values.get(f.id);
    if (!value) continue;
    if (value.unit !== f.unit || (!f.language && value.datatype !== f.datatype)) {
      throw new Error(`the value ${value.value} of ${f.id} was converted to another unit: the points of an expansion state the values as published, so read with { unit: 'source' }`);
    }
    let point: Term;
    const node = row.nodes?.get(f.id);
    if (node?.termType === 'NamedNode') point = node;
    else if (f.aboutUrl) {
      variables ??= Object.fromEntries(plan.variables.map(([name, id]) => [name, id === '' ? row.time : values.get(id)?.value]));
      point = namedNode(resolveIri(expandTemplate(f.aboutUrl, variables), plan.base));
    } else point = blankNode();
    const add = (predicate: string, object: Term) => out.push(quad(point as NamedNode, namedNode(predicate), object as NamedNode));
    out.push(quad(plan.source as NamedNode, namedNode(tss('hasPoint')), point as NamedNode));
    add(tss('field'), termOf(f.id));
    add(plan.time, timeLiteral);
    const result = valueLiteral(f, value);
    add(f.property, result);
    for (const d of plan.describers.get(f.id) ?? []) {
      const described = values.get(d.id);
      if (described) add(d.property, valueLiteral(d, described));
    }
    if (plan.align.has('sosa')) {
      add(RDF + 'type', namedNode(SOSA + 'Observation'));
      if (plan.timeAligned) add(SOSA + 'resultTime', timeLiteral);
      if (f.aligned) add(SOSA + 'hasSimpleResult', result);
      if (f.observedProperty) add(SOSA + 'observedProperty', termOf(f.observedProperty));
      if (f.sensor) add(SOSA + 'madeBySensor', termOf(f.sensor));
      if (f.featureOfInterest) add(SOSA + 'hasFeatureOfInterest', termOf(f.featureOfInterest));
      if (f.unit) add(QUDT + 'hasUnit', termOf(f.unit));
    }
    if (plan.align.has('saref')) {
      add(RDF + 'type', namedNode(SAREF + 'Measurement'));
      if (plan.timeAligned) add(SAREF + 'hasTimestamp', timeLiteral);
      if (f.aligned) add(SAREF + 'hasValue', result);
      if (f.observedProperty) add(SAREF + 'relatesToProperty', termOf(f.observedProperty));
      if (f.sensor) add(SAREF + 'measurementMadeBy', termOf(f.sensor));
      if (f.featureOfInterest) add(SAREF + 'isMeasurementOf', termOf(f.featureOfInterest));
      if (f.unit) add(SAREF + 'isMeasuredIn', termOf(f.unit));
    }
  }
  return out;
}

/**
 * Turn rows into RDF Messages, as the expansion of their source: a message with the metadata
 * of each source (unless `metadata: false`), and then one message per row with the points of
 * its value fields. The values have to be as published (read with `unit: 'source'`).
 */
export async function* toRDFMessages(rows: AsyncIterable<Row>, options: ExpandOptions = {}): AsyncGenerator<RDFMessage> {
  const described = new Set<ReadableSource>();
  for await (const row of rows) {
    if (options.metadata !== false && !described.has(row.source)) {
      described.add(row.source);
      yield expansionHead(row.source, options);
    }
    const quads = pointsOfRow(row, options);
    if (quads.length > 0) yield message(quads);
  }
}
