import { CONTEXT_FIELD, KIND_BY_CLASS, LEGACY_META_FIELD, LEGACY_SOURCE_CLASSES, RDF, RDFS, SOURCE_CLASSES, VALUE_FIELD, isExternalKind, tss, xsd } from './ns.js';
import type { Dataset, Term } from './rdf.js';
import { namedNode, objectOf, objectsOf, subjectsOf, termId } from './rdf.js';
import { ValidationError } from './errors.js';
import { defaultPropertyIri, resolveIri } from './iri.js';
import type { FieldKind, FieldMetadata, FieldSummary, SourceKind, SourceMetadata } from './types.js';

export interface ParsedSource {
  term: Term;
  metadata: SourceMetadata;
  /** The RDF term of each field, by field id. */
  fieldTerms: Map<string, Term>;
}

/** The part of an IRI after the last `#` or `/`. */
export function localNameOf(iri: string): string {
  const trimmed = iri.replace(/[#/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('#'), trimmed.lastIndexOf('/'));
  const name = index >= 0 ? trimmed.slice(index + 1) : trimmed;
  return name || iri;
}

/** The sources a document describes: nodes with a source class as type. */
export function findSources(ds: Dataset): { term: Term; kind: SourceKind }[] {
  const found = new Map<string, { term: Term; kind: SourceKind }>();
  for (const iri of Object.values(SOURCE_CLASSES)) {
    for (const subject of subjectsOf(ds, RDF + 'type', namedNode(iri))) {
      found.set(termId(subject), { term: subject, kind: KIND_BY_CLASS[iri] });
    }
  }
  return [...found.values()];
}

const text = (ds: Dataset, subject: Term, predicate: string) => objectOf(ds, subject, predicate)?.value;
const iriOrUndefined = (ds: Dataset, subject: Term, predicate: string) => {
  const object = objectOf(ds, subject, predicate);
  return object ? termId(object) : undefined;
};
const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));

function parseSummary(ds: Dataset, node: Term): FieldSummary {
  const summary: FieldSummary = {};
  const set = <K extends keyof FieldSummary>(key: K, value: FieldSummary[K]) => {
    if (value !== undefined) summary[key] = value;
  };
  set('missingValuePolicy', iriOrUndefined(ds, node, tss('missingValuePolicy')));
  set('count', number(text(ds, node, tss('count'))));
  set('missing', number(text(ds, node, tss('missing'))));
  set('firstTime', text(ds, node, tss('firstTime')));
  set('lastTime', text(ds, node, tss('lastTime')));
  set('observedMinimum', text(ds, node, tss('observedMinimum')));
  set('observedMaximum', text(ds, node, tss('observedMaximum')));
  set('mean', text(ds, node, tss('mean')));
  set('median', text(ds, node, tss('median')));
  set('generatedAtTime', text(ds, node, tss('generatedAtTime')));
  return summary;
}

/**
 * Whether a field states `tss:ValueField` or `tss:ContextField`, and which. `tss:MetaField`,
 * the name of earlier drafts, counts as `tss:ContextField`.
 */
export function statedFieldKinds(ds: Dataset, term: Term): FieldKind[] {
  const kinds: FieldKind[] = [];
  for (const type of objectsOf(ds, term, RDF + 'type')) {
    if (type.value === VALUE_FIELD) kinds.push('value');
    if (type.value === CONTEXT_FIELD || type.value === LEGACY_META_FIELD) kinds.push('context');
  }
  return kinds;
}

/** A property that is not the field property of a describing field: `rdf:type` and the terms of the TSS vocabulary. */
export const isReservedProperty = (iri: string) => iri === RDF + 'type' || iri.startsWith(tss(''));

function parseField(ds: Dataset, term: Term, inferredKind: FieldKind): FieldMetadata {
  const id = termId(term);
  const columnName = text(ds, term, tss('columnName'));
  const stated = statedFieldKinds(ds, term);
  const field: FieldMetadata = {
    id,
    localName: term.termType === 'NamedNode' ? localNameOf(term.value) : (columnName ?? id),
    kind: stated.length === 1 ? stated[0] : inferredKind,
    labels: objectsOf(ds, term, RDFS + 'label').map((o) => o.value),
    datatype: iriOrUndefined(ds, term, tss('datatype')) ?? xsd('string'),
    defaultProperty: true,
    describesField: objectsOf(ds, term, tss('describesField')).map(termId),
  };
  const set = <K extends keyof FieldMetadata>(key: K, value: FieldMetadata[K]) => {
    if (value !== undefined) field[key] = value;
  };
  set('language', text(ds, term, tss('language')));
  set('columnName', columnName);
  set('columnIndex', number(text(ds, term, tss('columnIndex'))));
  // only a describing field has a field property
  const property = objectOf(ds, term, tss('property'));
  if (property?.termType === 'NamedNode' && field.describesField.length > 0 && !isReservedProperty(property.value)) {
    field.property = property.value;
    field.defaultProperty = false;
  }
  set('aboutUrl', text(ds, term, tss('aboutUrl')));
  set('observedProperty', iriOrUndefined(ds, term, tss('observedProperty')));
  set('unit', iriOrUndefined(ds, term, tss('unit')));
  set('sensor', iriOrUndefined(ds, term, tss('sensor')));
  set('featureOfInterest', iriOrUndefined(ds, term, tss('featureOfInterest')));
  set('minimum', text(ds, term, tss('minimum')));
  set('maximum', text(ds, term, tss('maximum')));
  set('valueEncoding', iriOrUndefined(ds, term, tss('valueEncoding')));
  set('baseline', text(ds, term, tss('baseline')));
  const summaryNode = objectOf(ds, term, tss('summary'));
  if (summaryNode) set('summary', parseSummary(ds, summaryNode));
  return field;
}

/**
 * The base IRI of the default field properties (of describing fields) and the point IRIs of a source: its data file
 * (external), or the metadata document (embedded).
 */
export function propertyBase(metadata: Pick<SourceMetadata, 'kind' | 'dataFile'>, documentIri?: string): string | undefined {
  if (!isExternalKind(metadata.kind)) return documentIri;
  if (!metadata.dataFile) return undefined;
  try {
    return resolveIri(metadata.dataFile, documentIri);
  } catch {
    return undefined;
  }
}

/** The error to give for a document without sources: it may use the class names of earlier drafts. */
function noSourceError(ds: Dataset): ValidationError {
  for (const [legacy, current] of Object.entries(LEGACY_SOURCE_CLASSES)) {
    if (subjectsOf(ds, RDF + 'type', namedNode(legacy)).length > 0) {
      return new ValidationError(`the document describes no source: ${legacy} is an RDF Time Series Snippets class of an earlier draft, now ${current}`);
    }
  }
  return new ValidationError('the document describes no source (no node has a source class as type)');
}

export interface ParseOptions {
  /** The IRI of the source, when the document has several. */
  source?: string;
  /** The IRI of the metadata document: the base of a relative data file and of the default field properties. */
  baseIRI?: string;
}

/** Read the description of one source from a metadata document. */
export function parseSource(ds: Dataset, options: ParseOptions = {}): ParsedSource {
  const sources = findSources(ds);
  if (sources.length === 0) throw noSourceError(ds);
  let chosen = sources[0];
  if (options.source) {
    const match = sources.find((s) => termId(s.term) === options.source);
    if (!match) throw new ValidationError(`the document has no source ${options.source}`);
    chosen = match;
  } else if (sources.length > 1) {
    const ids = sources.map((s) => termId(s.term)).join(', ');
    throw new ValidationError(`the document describes several sources (${ids}); pass { source } to choose one`);
  }
  const { term, kind } = chosen;

  const timeField = iriOrUndefined(ds, term, tss('timeField'));
  if (!timeField) throw new ValidationError(`source ${termId(term)} has no tss:timeField`);
  const stepField = iriOrUndefined(ds, term, tss('stepField'));
  const fieldTermList = objectsOf(ds, term, tss('hasField'));
  const describing = new Set(fieldTermList.filter((t) => objectsOf(ds, t, tss('describesField')).length > 0).map(termId));

  const fieldTerms = new Map<string, Term>();
  const fields: FieldMetadata[] = [];
  for (const fieldTerm of fieldTermList) {
    const id = termId(fieldTerm);
    if (fieldTerms.has(id)) continue;
    const inferred: FieldKind = id === timeField || id === stepField || describing.has(id) ? 'context' : 'value';
    fieldTerms.set(id, fieldTerm);
    fields.push(parseField(ds, fieldTerm, inferred));
  }
  if (!fieldTerms.has(timeField)) throw new ValidationError(`the time field ${timeField} of ${termId(term)} is not one of its fields`);

  const isTrue = (value: string | undefined) => value === 'true' || value === '1';
  // `tss:immutable true` ends a source. Earlier drafts stated `tss:mutable`: `false` is the same.
  const legacyMutable = text(ds, term, tss('mutable'));
  const immutable = isTrue(text(ds, term, tss('immutable'))) || kind === 'Parquet' || legacyMutable === 'false' || legacyMutable === '0';

  const metadata: SourceMetadata = {
    id: termId(term),
    kind,
    labels: objectsOf(ds, term, RDFS + 'label').map((o) => o.value),
    immutable,
    timeField,
    fields,
    delimiter: text(ds, term, tss('delimiter')) ?? ',',
    encoding: text(ds, term, tss('encoding')) ?? 'utf-8',
    header: (text(ds, term, tss('header')) ?? 'true') !== 'false' && text(ds, term, tss('header')) !== '0',
  };
  const set = <K extends keyof SourceMetadata>(key: K, value: SourceMetadata[K]) => {
    if (value !== undefined) metadata[key] = value;
  };
  set('from', text(ds, term, tss('from')));
  set('until', text(ds, term, tss('until')));
  set('stepField', stepField);
  set('timeBase', text(ds, term, tss('timeBase')));
  set('timeStep', text(ds, term, tss('timeStep')));
  set('dataFile', iriOrUndefined(ds, term, tss('dataFile')));
  set('producedBy', iriOrUndefined(ds, term, tss('producedBy')));

  // the default field properties of the describing fields
  const base = propertyBase(metadata, options.baseIRI);
  for (const f of fields) {
    if (!f.defaultProperty || f.describesField.length === 0) continue;
    if (f.columnName !== undefined && f.columnName !== '' && base) f.property = defaultPropertyIri(base, f.columnName);
  }
  return { term, metadata, fieldTerms };
}
