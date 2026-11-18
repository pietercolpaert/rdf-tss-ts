import { KIND_BY_CLASS, RDF, RDFS, SNIPPET_CLASSES, tss, xsd } from './ns.js';
import type { Dataset, Term } from './rdf.js';
import { namedNode, objectOf, objectsOf, subjectsOf, termId } from './rdf.js';
import { ValidationError } from './errors.js';
import type { FieldMetadata, FieldSummary, SnippetKind, SnippetMetadata } from './types.js';

export interface ParsedSnippet {
  term: Term;
  metadata: SnippetMetadata;
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

/** The snippets a document describes: nodes with a snippet class as type. */
export function findSnippets(ds: Dataset): { term: Term; kind: SnippetKind }[] {
  const found = new Map<string, { term: Term; kind: SnippetKind }>();
  for (const iri of Object.values(SNIPPET_CLASSES)) {
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

function parseField(ds: Dataset, term: Term): FieldMetadata {
  const id = termId(term);
  const columnName = text(ds, term, tss('columnName'));
  const field: FieldMetadata = {
    id,
    localName: term.termType === 'NamedNode' ? localNameOf(term.value) : (columnName ?? id),
    labels: objectsOf(ds, term, RDFS + 'label').map((o) => o.value),
    datatype: iriOrUndefined(ds, term, tss('datatype')) ?? xsd('string'),
    describesField: objectsOf(ds, term, tss('describesField')).map(termId),
  };
  const set = <K extends keyof FieldMetadata>(key: K, value: FieldMetadata[K]) => {
    if (value !== undefined) field[key] = value;
  };
  set('language', text(ds, term, tss('language')));
  set('columnName', columnName);
  set('columnIndex', number(text(ds, term, tss('columnIndex'))));
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
 * Read the description of one snippet from a metadata document. When the document has
 * several snippets, `snippetIri` says which one.
 */
export function parseSnippet(ds: Dataset, snippetIri?: string): ParsedSnippet {
  const snippets = findSnippets(ds);
  if (snippets.length === 0) throw new ValidationError('the document describes no snippet (no node has a snippet class as type)');
  let chosen = snippets[0];
  if (snippetIri) {
    const match = snippets.find((s) => termId(s.term) === snippetIri);
    if (!match) throw new ValidationError(`the document has no snippet ${snippetIri}`);
    chosen = match;
  } else if (snippets.length > 1) {
    const ids = snippets.map((s) => termId(s.term)).join(', ');
    throw new ValidationError(`the document describes several snippets (${ids}); pass { snippet } to choose one`);
  }
  const { term, kind } = chosen;

  const fieldTerms = new Map<string, Term>();
  const fields: FieldMetadata[] = [];
  for (const fieldTerm of objectsOf(ds, term, tss('hasField'))) {
    const field = parseField(ds, fieldTerm);
    if (fieldTerms.has(field.id)) continue;
    fieldTerms.set(field.id, fieldTerm);
    fields.push(field);
  }
  const timeField = iriOrUndefined(ds, term, tss('timeField'));
  if (!timeField) throw new ValidationError(`snippet ${termId(term)} has no tss:timeField`);
  if (!fieldTerms.has(timeField)) throw new ValidationError(`the time field ${timeField} of ${termId(term)} is not one of its fields`);

  const metadata: SnippetMetadata = {
    id: termId(term),
    kind,
    labels: objectsOf(ds, term, RDFS + 'label').map((o) => o.value),
    mutable: text(ds, term, tss('mutable')) === 'true' || text(ds, term, tss('mutable')) === '1',
    timeField,
    fields,
    delimiter: text(ds, term, tss('delimiter')) ?? ',',
    encoding: text(ds, term, tss('encoding')) ?? 'utf-8',
    header: (text(ds, term, tss('header')) ?? 'true') !== 'false' && text(ds, term, tss('header')) !== '0',
  };
  const set = <K extends keyof SnippetMetadata>(key: K, value: SnippetMetadata[K]) => {
    if (value !== undefined) metadata[key] = value;
  };
  set('from', text(ds, term, tss('from')));
  set('until', text(ds, term, tss('until')));
  set('committedUntil', text(ds, term, tss('committedUntil')));
  set('stepField', iriOrUndefined(ds, term, tss('stepField')));
  set('timeBase', text(ds, term, tss('timeBase')));
  set('timeStep', text(ds, term, tss('timeStep')));
  set('dataFile', iriOrUndefined(ds, term, tss('dataFile')));
  set('producedBy', iriOrUndefined(ds, term, tss('producedBy')));
  return { term, metadata, fieldTerms };
}
