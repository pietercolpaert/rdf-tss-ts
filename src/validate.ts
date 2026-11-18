import { makeReport, type Report, type ReportEntry } from './errors.js';
import { isNumericDatatype, isValidLexical } from './lexical.js';
import { findSnippets } from './metadata.js';
import { RDF, SNIPPET_CLASSES, isExternalKind, tss, xsd } from './ns.js';
import type { Dataset, Term } from './rdf.js';
import { objectsOf, termId } from './rdf.js';
import type { ReadableSnippet } from './readable.js';
import { parseDuration, tryInstantOf } from './time.js';

const LIMIT = 200;

const isBoolean = (t: Term) => t.termType === 'Literal' && ['true', 'false', '1', '0'].includes(t.value);

/** Check a snippet against the requirements of the specification, and say where each fails. */
export async function validateSnippet(snippet: ReadableSnippet): Promise<Report> {
  const results: ReportEntry[] = [];
  const add = (rule: string, message: string, node?: string, row?: number) => {
    if (results.length < LIMIT) results.push({ rule, message, node, row });
    else if (results.length === LIMIT) results.push({ rule: 'truncated', message: `more than ${LIMIT} findings; the rest is left out` });
  };
  metadataRules(snippet, add);
  await dataRules(snippet, add);
  return makeReport(results);
}

type Add = (rule: string, message: string, node?: string, row?: number) => void;

function metadataRules(snippet: ReadableSnippet, add: Add): void {
  const ds = snippet.dataset;
  const node = snippet.node;
  const meta = snippet.metadata;
  const id = snippet.id;
  const many = (subject: Term, predicate: string) => objectsOf(ds, subject, predicate);

  // classes
  const classes = many(node, RDF + 'type').filter((t) => Object.values(SNIPPET_CLASSES).includes(t.value as never));
  if (classes.length !== 1) add('snippet-class', `a snippet has exactly one snippet class, not ${classes.length}`, id);

  // one kind of snippet per document
  const kinds = new Set(findSnippets(ds).map((s) => isExternalKind(s.kind)));
  if (kinds.size > 1) add('document-kind', 'all snippets of a document are embedded, or all are external', id);

  // immutable; tss:mutable and tss:committedUntil are gone
  const immutable = many(node, tss('immutable'));
  if (immutable.length > 1 || (immutable[0] && !isBoolean(immutable[0]))) add('immutable', 'tss:immutable is optional, once, and an xsd:boolean', id);
  const isImmutable = immutable[0] && (immutable[0].value === 'true' || immutable[0].value === '1');
  if (meta.kind === 'Parquet' && !isImmutable) add('immutable', 'a tss:ParquetSnippet cannot be appended to: it states tss:immutable true', id);
  for (const removed of ['mutable', 'committedUntil']) {
    if (many(node, tss(removed)).length > 0) add('removed-term', `tss:${removed} is no longer part of the vocabulary: use tss:immutable, and HTTP validators to follow a snippet`, id);
  }
  if (!meta.immutable) {
    for (const f of meta.fields) if (f.summary) add('growing-summary', 'a field of a growing snippet has no tss:summary: it is added when the snippet is ended', f.id);
  }

  // fields, time field, key
  const fieldTerms = many(node, tss('hasField'));
  if (fieldTerms.length === 0) add('has-field', 'a snippet has one or more tss:hasField', id);
  const fieldIds = new Set(fieldTerms.map(termId));
  const timeFields = many(node, tss('timeField'));
  if (timeFields.length !== 1) add('time-field', 'a snippet has exactly one tss:timeField', id);
  else if (!fieldIds.has(termId(timeFields[0]))) add('time-field', 'the time field is one of the fields of the snippet', id);
  const keys = many(node, tss('key'));
  if (keys.length > 1 || (keys.length === 1 && timeFields[0] && termId(keys[0]) !== termId(timeFields[0]))) {
    add('key', 'a snippet states at most one tss:key, and it is the time field', id);
  }

  // window
  const from = many(node, tss('from'));
  const until = many(node, tss('until'));
  if (from.length > 1) add('window', 'at most one tss:from', id);
  if (until.length > 1) add('window', 'at most one tss:until', id);
  for (const [name, terms] of [['tss:from', from], ['tss:until', until]] as const) {
    if (terms[0] && tryInstantOf(terms[0].value) === null) add('window', `${name} is an xsd:dateTimeStamp`, id);
  }
  if (from[0] && until[0]) {
    const a = tryInstantOf(from[0].value);
    const b = tryInstantOf(until[0].value);
    if (a !== null && b !== null && b <= a) add('window', 'tss:until comes after tss:from', id);
  }

  // class specific properties
  const has = (predicate: string) => many(node, predicate).length > 0;
  const forbid = (predicates: string[], why: string) => {
    for (const p of predicates) if (has(tss(p))) add('not-allowed', `tss:${p} is not allowed ${why}`, id);
  };
  const external = isExternalKind(meta.kind);
  if (!external) {
    forbid(['dataFile', 'delimiter', 'encoding', 'header', 'timeBase', 'timeStep', 'stepField'], 'on an embedded snippet');
  } else {
    forbid(['hasPoint', 'points'], 'on an external snippet');
    if (many(node, tss('dataFile')).length !== 1) add('data-file', 'an external snippet has exactly one tss:dataFile', id);
  }
  if (meta.kind === 'EmbeddedRDF') forbid(['points'], 'on a tss:EmbeddedRDFSnippet');
  if (meta.kind === 'EmbeddedJSON') {
    forbid(['hasPoint'], 'on a tss:EmbeddedJSONSnippet');
    const points = many(node, tss('points'));
    if (points.length !== 1 || points[0].termType !== 'Literal' || points[0].value === undefined) {
      add('points', 'a tss:EmbeddedJSONSnippet has exactly one tss:points, an rdf:JSON literal', id);
    } else if ((points[0] as { datatype?: { value: string } }).datatype?.value !== RDF + 'JSON') {
      add('points', 'tss:points is an rdf:JSON literal', id);
    }
  }
  if (meta.kind !== 'CSV') forbid(['delimiter', 'encoding', 'header'], 'on a snippet that is not a tss:CSVSnippet');
  const delimiter = many(node, tss('delimiter'))[0];
  if (delimiter && [...delimiter.value].length !== 1) add('delimiter', 'tss:delimiter is one character', id);
  const header = many(node, tss('header'))[0];
  if (header && !isBoolean(header)) add('header', 'tss:header is an xsd:boolean', id);

  // time grid
  const base = many(node, tss('timeBase'));
  const step = many(node, tss('timeStep'));
  const hasGrid = base.length > 0 || step.length > 0;
  if (hasGrid) {
    if (base.length !== 1 || step.length !== 1) add('time-grid', 'tss:timeBase and tss:timeStep are stated together, once', id);
    if (base[0] && tryInstantOf(base[0].value) === null) add('time-grid', 'tss:timeBase is an xsd:dateTimeStamp', id);
    const duration = step[0] ? parseDuration(step[0].value) : null;
    if (step[0] && (!duration || (!duration.years && !duration.months && !duration.days && duration.clockNs === 0n))) {
      add('time-grid', 'tss:timeStep is an xsd:duration of more than zero', id);
    }
    const stepFields = many(node, tss('stepField'));
    if (stepFields.length !== 1) add('step-field', 'a time grid has exactly one tss:stepField', id);
    else {
      const stepId = termId(stepFields[0]);
      const stepField = meta.fields.find((f) => f.id === stepId);
      if (!stepField) add('step-field', 'the step field is one of the fields of the snippet', id);
      else if (stepId === meta.timeField) add('step-field', 'the step field is not the time field', id);
      else if (stepField.datatype !== xsd('integer')) add('step-field', 'the datatype of the step field is xsd:integer', stepId);
    }
  } else if (has(tss('stepField'))) {
    add('step-field', 'tss:stepField is not allowed without a time grid', id);
  }

  // fields
  const names = new Map<string, string>();
  const indexes = new Map<number, string>();
  for (const fieldTerm of fieldTerms) {
    const f = meta.fields.find((x) => x.id === termId(fieldTerm));
    if (!f) continue;
    const at = f.id;
    const datatypes = many(fieldTerm, tss('datatype'));
    if (datatypes.length !== 1 || datatypes[0].termType !== 'NamedNode') add('datatype', 'a field has exactly one tss:datatype (an IRI)', at);
    const isTime = f.id === meta.timeField;
    if (isTime && f.datatype !== xsd('dateTimeStamp')) add('time-datatype', 'the datatype of the time field is xsd:dateTimeStamp', at);

    const columnNames = many(fieldTerm, tss('columnName'));
    const noColumnNeeded = (isTime && hasGrid) || meta.kind === 'EmbeddedRDF';
    if (columnNames.length > 1) add('column-name', 'a field has at most one tss:columnName', at);
    if (columnNames.length === 0 && !noColumnNeeded) add('column-name', 'a field of this snippet needs a tss:columnName', at);
    if (columnNames[0]) {
      if (columnNames[0].value === '') add('column-name', 'tss:columnName is not empty', at);
      const other = names.get(columnNames[0].value);
      if (other) add('column-name', `tss:columnName ${JSON.stringify(columnNames[0].value)} is also used by ${other}`, at);
      names.set(columnNames[0].value, at);
      if (isTime && hasGrid) add('column-name', 'the time field of a time grid has no tss:columnName', at);
    }
    if (f.columnIndex !== undefined) {
      if (!Number.isInteger(f.columnIndex) || f.columnIndex < 0) add('column-index', 'tss:columnIndex is 0 or more', at);
      const other = indexes.get(f.columnIndex);
      if (other) add('column-index', `tss:columnIndex ${f.columnIndex} is also used by ${other}`, at);
      indexes.set(f.columnIndex, at);
      if (isTime && hasGrid) add('column-index', 'the time field of a time grid has no tss:columnIndex', at);
    }
    if (meta.kind === 'CSV' && !meta.header && f.columnIndex === undefined && !(isTime && hasGrid)) {
      add('column-index', 'a field of a CSV file without a header line needs a tss:columnIndex', at);
    }
    if (f.language && f.datatype !== RDF + 'langString') add('language', 'tss:language is for rdf:langString fields', at);
    if (f.valueEncoding) {
      if (!external) add('value-encoding', 'an embedded snippet has no tss:valueEncoding', at);
      if (isTime) add('value-encoding', 'the time field has no tss:valueEncoding', at);
      if (f.valueEncoding === tss('DeltaFromBaseline') && (f.baseline === undefined || !isNumericDatatype(f.datatype))) {
        add('baseline', 'tss:DeltaFromBaseline needs one numeric tss:baseline', at);
      }
    } else if (f.baseline !== undefined) {
      add('baseline', 'tss:baseline needs tss:DeltaFromBaseline', at);
    }
    if (f.minimum !== undefined && f.maximum !== undefined && Number(f.maximum) < Number(f.minimum)) {
      add('range', 'tss:maximum is not below tss:minimum', at);
    }
    for (const target of f.describesField) if (!fieldIds.has(target)) add('describes-field', `${target} is not a field of this snippet`, at);
  }
}

async function dataRules(snippet: ReadableSnippet, add: Add): Promise<void> {
  const meta = snippet.metadata;
  const fields = new Map(meta.fields.map((f) => [f.id, f]));
  const embedded = !isExternalKind(meta.kind);
  const seen = new Map<bigint, number>();
  const from = meta.from ? tryInstantOf(meta.from) : null;
  const until = meta.until ? tryInstantOf(meta.until) : null;

  if (meta.kind === 'EmbeddedRDF') embeddedRdfRules(snippet, add);

  let row = 0;
  try {
    for await (const raw of snippet.points({ skip: 0, strict: false })) {
      row++;
      const instant = tryInstantOf(raw.time);
      if (instant === null) {
        add('time', `the time ${JSON.stringify(raw.time)} is not an xsd:dateTimeStamp`, undefined, row);
        continue;
      }
      const earlier = seen.get(instant);
      if (earlier !== undefined) add('unique-time', `the time ${raw.time} is also the time of row ${earlier}: no two points have the same time`, undefined, row);
      else seen.set(instant, row);
      if (embedded && ((from !== null && instant < from) || (until !== null && instant >= until))) {
        add('window', `the time ${raw.time} lies outside the time window of the snippet`, undefined, row);
      }
      for (const [fieldId, text] of raw.values) {
        const f = fields.get(fieldId)!;
        if (!isValidLexical(f.datatype, text)) add('lexical-form', `${JSON.stringify(text)} is not a valid ${f.datatype}`, fieldId, row);
      }
    }
  } catch (error) {
    add('data', `the data could not be read: ${(error as Error).message}`, snippet.id, row + 1);
  }
}

function embeddedRdfRules(snippet: ReadableSnippet, add: Add): void {
  const ds: Dataset = snippet.dataset;
  const meta = snippet.metadata;
  let row = 0;
  for (const point of objectsOf(ds, snippet.node, tss('hasPoint'))) {
    row++;
    for (const f of meta.fields) {
      const objects = objectsOf(ds, point, f.id);
      if (objects.length > 1) add('one-value', `a point has at most one value for a field, not ${objects.length}`, f.id, row);
      for (const o of objects) {
        const datatype = o.termType === 'Literal' ? (o as { datatype?: { value: string } }).datatype?.value : undefined;
        if (o.termType !== 'Literal') add('literal', 'a value of an RDF point is a literal', f.id, row);
        else if (f.datatype !== RDF + 'langString' && datatype !== f.datatype) {
          add('value-datatype', `the datatype of the value is ${datatype}, the field says ${f.datatype}`, f.id, row);
        }
      }
    }
  }
}
