import { makeReport, type Report, type ReportEntry } from './errors.js';
import { expandTemplate, resolveIri } from './iri.js';
import { isNumericDatatype, isValidLexical } from './lexical.js';
import { findSources, propertyBase, statedFieldKinds } from './metadata.js';
import { LEGACY_SOURCE_CLASSES, RDF, SOURCE_CLASSES, isExternalKind, tss, xsd } from './ns.js';
import type { Dataset, Term } from './rdf.js';
import { namedNode, objectsOf, termId } from './rdf.js';
import type { ReadableSource } from './readable.js';
import { parseDuration, tryInstantOf } from './time.js';

const LIMIT = 200;

/** The datatypes of a time of a source; `xsd:dateTime` is recommended. */
const TIME_DATATYPES = [xsd('dateTime'), xsd('dateTimeStamp')];

/** A time stated in the metadata: a literal with one of the time datatypes, and a timezone. */
const isTimeLiteral = (t: Term) =>
  t.termType === 'Literal' && TIME_DATATYPES.includes((t as { datatype?: { value: string } }).datatype?.value ?? '') && tryInstantOf(t.value) !== null;

const isBoolean = (t: Term) => t.termType === 'Literal' && ['true', 'false', '1', '0'].includes(t.value);

/** Check a source against the requirements of the specification, and say where each fails. */
export async function validateSource(source: ReadableSource): Promise<Report> {
  const results: ReportEntry[] = [];
  const add = (rule: string, message: string, node?: string, row?: number) => {
    if (results.length < LIMIT) results.push({ rule, message, node, row });
    else if (results.length === LIMIT) results.push({ rule: 'truncated', message: `more than ${LIMIT} findings; the rest is left out` });
  };
  metadataRules(source, add);
  await dataRules(source, add);
  return makeReport(results);
}

type Add = (rule: string, message: string, node?: string, row?: number) => void;

function metadataRules(source: ReadableSource, add: Add): void {
  const ds = source.dataset;
  const node = source.node;
  const meta = source.metadata;
  const id = source.id;
  const many = (subject: Term, predicate: string) => objectsOf(ds, subject, predicate);

  // classes
  const types = many(node, RDF + 'type');
  const classes = types.filter((t) => Object.values(SOURCE_CLASSES).includes(t.value as never));
  if (classes.length !== 1) add('source-class', `a source has exactly one source class, not ${classes.length}`, id);
  for (const t of types) {
    if (LEGACY_SOURCE_CLASSES[t.value]) add('removed-term', `${t.value} was renamed to ${LEGACY_SOURCE_CLASSES[t.value]}`, id);
  }

  // one kind of source per document
  const kinds = new Set(findSources(ds).map((s) => isExternalKind(s.kind)));
  if (kinds.size > 1) add('document-kind', 'all sources of a document are embedded, or all are external', id);

  // immutable; tss:mutable, tss:committedUntil and tss:snippetDescription are gone
  const immutable = many(node, tss('immutable'));
  if (immutable.length > 1 || (immutable[0] && !isBoolean(immutable[0]))) add('immutable', 'tss:immutable is optional, once, and an xsd:boolean', id);
  const isImmutable = immutable[0] && (immutable[0].value === 'true' || immutable[0].value === '1');
  if (meta.kind === 'Parquet' && !isImmutable) add('immutable', 'a tss:ParquetSource cannot be appended to: it states tss:immutable true', id);
  for (const removed of ['mutable', 'committedUntil']) {
    if (many(node, tss(removed)).length > 0) add('removed-term', `tss:${removed} is no longer part of the vocabulary: use tss:immutable, and HTTP validators to follow a source`, id);
  }
  if (many(node, tss('snippetDescription')).length > 0) add('removed-term', 'tss:snippetDescription was renamed to tss:sourceDescription', id);
  if (many(node, tss('sourceDescription')).length > 1) add('source-description', 'a source has at most one tss:sourceDescription', id);
  if (!meta.immutable) {
    for (const f of meta.fields) if (f.summary) add('growing-summary', 'a field of a growing source has no tss:summary: it is added when the source is ended', f.id);
  }

  // fields, time field, key
  const fieldTerms = many(node, tss('hasField'));
  if (fieldTerms.length === 0) add('has-field', 'a source has one or more tss:hasField', id);
  const fieldIds = new Set(fieldTerms.map(termId));
  const timeFields = many(node, tss('timeField'));
  if (timeFields.length !== 1) add('time-field', 'a source has exactly one tss:timeField', id);
  else if (!fieldIds.has(termId(timeFields[0]))) add('time-field', 'the time field is one of the fields of the source', id);
  const keys = many(node, tss('key'));
  if (keys.length > 1 || (keys.length === 1 && timeFields[0] && termId(keys[0]) !== termId(timeFields[0]))) {
    add('key', 'a source states at most one tss:key, and it is the time field', id);
  }

  // window
  const from = many(node, tss('from'));
  const until = many(node, tss('until'));
  if (from.length > 1) add('window', 'at most one tss:from', id);
  if (until.length > 1) add('window', 'at most one tss:until', id);
  for (const [name, terms] of [['tss:from', from], ['tss:until', until]] as const) {
    if (terms[0] && !isTimeLiteral(terms[0])) add('window', `${name} is an xsd:dateTime (or xsd:dateTimeStamp) with a timezone`, id);
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
    forbid(['dataFile', 'delimiter', 'encoding', 'header', 'timeBase', 'timeStep', 'stepField'], 'on an embedded source');
  } else {
    forbid(['hasPoint', 'points'], 'on an external source');
    if (many(node, tss('dataFile')).length !== 1) add('data-file', 'an external source has exactly one tss:dataFile', id);
  }
  if (meta.kind === 'EmbeddedRDF') forbid(['points'], 'on a tss:EmbeddedRDFSource');
  if (meta.kind === 'EmbeddedJSON') {
    forbid(['hasPoint'], 'on a tss:EmbeddedJSONSource');
    const points = many(node, tss('points'));
    if (points.length !== 1 || points[0].termType !== 'Literal' || points[0].value === undefined) {
      add('points', 'a tss:EmbeddedJSONSource has exactly one tss:points, an rdf:JSON literal', id);
    } else if ((points[0] as { datatype?: { value: string } }).datatype?.value !== RDF + 'JSON') {
      add('points', 'tss:points is an rdf:JSON literal', id);
    }
  }
  if (meta.kind !== 'CSV') forbid(['delimiter', 'encoding', 'header'], 'on a source that is not a tss:CSVSource');
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
    if (base[0] && !isTimeLiteral(base[0])) add('time-grid', 'tss:timeBase is an xsd:dateTime (or xsd:dateTimeStamp) with a timezone', id);
    const duration = step[0] ? parseDuration(step[0].value) : null;
    if (step[0] && (!duration || (!duration.years && !duration.months && !duration.days && duration.clockNs === 0n))) {
      add('time-grid', 'tss:timeStep is an xsd:duration of more than zero', id);
    }
    // without a step field, the step of a row is its position in the data file
    const stepFields = many(node, tss('stepField'));
    if (stepFields.length > 1) add('step-field', 'a time grid has at most one tss:stepField', id);
    else if (stepFields.length === 1) {
      const stepId = termId(stepFields[0]);
      const stepField = meta.fields.find((f) => f.id === stepId);
      if (!stepField) add('step-field', 'the step field is one of the fields of the source', id);
      else if (stepId === meta.timeField) add('step-field', 'the step field is not the time field', id);
      else if (stepField.datatype !== xsd('integer')) add('step-field', 'the datatype of the step field is xsd:integer', stepId);
    }
  } else if (has(tss('stepField'))) {
    add('step-field', 'tss:stepField is not allowed without a time grid', id);
  }

  // fields
  const names = new Map<string, string>();
  const indexes = new Map<number, string>();
  const properties = new Map<string, string>();
  const describing = new Set(meta.fields.filter((f) => f.describesField.length > 0).map((f) => f.id));
  for (const fieldTerm of fieldTerms) {
    const f = meta.fields.find((x) => x.id === termId(fieldTerm));
    if (!f) continue;
    const at = f.id;
    const isTime = f.id === meta.timeField;

    // value field or meta field
    const stated = statedFieldKinds(ds, fieldTerm);
    if (stated.length !== 1) {
      add('field-kind', `a field states exactly one of tss:ValueField and tss:MetaField as its type, not ${stated.length === 0 ? 'none' : 'both'}`, at);
    }
    const role = isTime ? 'the time field' : f.id === meta.stepField ? 'the step field' : describing.has(f.id) ? 'a describing field' : undefined;
    if (role && f.kind !== 'meta') add('field-kind', `${role} is a tss:MetaField`, at);
    if (f.kind === 'meta') {
      for (const p of ['observedProperty', 'sensor', 'featureOfInterest', 'aboutUrl']) {
        if (many(fieldTerm, tss(p)).length > 0) add('meta-field', `a meta field has no tss:${p}`, at);
      }
    }

    const datatypes = many(fieldTerm, tss('datatype'));
    if (datatypes.length !== 1 || datatypes[0].termType !== 'NamedNode') add('datatype', 'a field has exactly one tss:datatype (an IRI)', at);
    if (isTime && !TIME_DATATYPES.includes(f.datatype)) add('time-datatype', 'the datatype of the time field is xsd:dateTime or xsd:dateTimeStamp', at);

    // the field property
    const stated_ = many(fieldTerm, tss('property'));
    if (stated_.length > 1 || (stated_[0] && stated_[0].termType !== 'NamedNode')) add('property', 'a field has at most one tss:property, an IRI', at);
    if (stated_[0]?.value === tss('value') && f.kind === 'meta') add('property', 'a meta field does not state tss:value as its tss:property', at);
    if (stated_[0]?.value === tss('time') && !isTime) add('property', 'only the time field states tss:time as its tss:property', at);
    if (f.property) {
      const other = properties.get(f.property);
      if (other) add('property', `the field property ${f.property} is also the field property of ${other}`, at);
      properties.set(f.property, at);
    }

    const columnNames = many(fieldTerm, tss('columnName'));
    const columnNeeded = meta.kind === 'EmbeddedRDF' ? !isTime && stated_.length === 0 : !(isTime && hasGrid);
    if (columnNames.length > 1) add('column-name', 'a field has at most one tss:columnName', at);
    if (columnNames.length === 0 && columnNeeded) {
      add('column-name', meta.kind === 'EmbeddedRDF' ? 'a field without tss:property needs a tss:columnName to make its default property' : 'a field of this source needs a tss:columnName', at);
    }
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
    if (f.aboutUrl !== undefined && meta.kind === 'EmbeddedRDF') add('about-url', 'the points of a tss:EmbeddedRDFSource are RDF nodes already: its fields have no tss:aboutUrl', at);
    if (f.language && f.datatype !== RDF + 'langString') add('language', 'tss:language is for rdf:langString fields', at);
    if (f.valueEncoding) {
      if (!external) add('value-encoding', 'an embedded source has no tss:valueEncoding', at);
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
    for (const target of f.describesField) {
      const described = meta.fields.find((x) => x.id === target);
      if (!fieldIds.has(target) || !described) add('describes-field', `${target} is not a field of this source`, at);
      else if (described.kind !== 'value') add('describes-field', `${target} is not a value field: a describing field describes a value field`, at);
    }
  }
}

async function dataRules(source: ReadableSource, add: Add): Promise<void> {
  const meta = source.metadata;
  const fields = new Map(meta.fields.map((f) => [f.id, f]));
  const embedded = !isExternalKind(meta.kind);
  const seen = new Map<bigint, number>();
  const from = meta.from ? tryInstantOf(meta.from) : null;
  const until = meta.until ? tryInstantOf(meta.until) : null;

  if (meta.kind === 'EmbeddedRDF') embeddedRdfRules(source, add);

  // the IRIs of the points (tss:aboutUrl) are unique within the source
  const templated = meta.fields.filter((f) => f.kind === 'value' && f.aboutUrl !== undefined && meta.kind !== 'EmbeddedRDF');
  const base = propertyBase(meta, source.baseIRI);
  const pointIris = new Map<string, number>();
  const named = meta.fields.filter((f) => f.columnName !== undefined);

  let row = 0;
  try {
    for await (const raw of source.rows({ skip: 0, strict: false })) {
      row++;
      const instant = tryInstantOf(raw.time);
      if (instant === null) {
        add('time', `the time ${JSON.stringify(raw.time)} is not a time with a timezone (an xsd:dateTime such as 2024-05-12T08:00:00Z)`, undefined, row);
        continue;
      }
      const earlier = seen.get(instant);
      if (earlier !== undefined) add('unique-time', `the time ${raw.time} is also the time of row ${earlier}: no two rows have the same time`, undefined, row);
      else seen.set(instant, row);
      if (embedded && ((from !== null && instant < from) || (until !== null && instant >= until))) {
        add('window', `the time ${raw.time} lies outside the time window of the source`, undefined, row);
      }
      for (const [fieldId, text] of raw.values) {
        const f = fields.get(fieldId)!;
        if (!isValidLexical(f.datatype, text)) add('lexical-form', `${JSON.stringify(text)} is not a valid ${f.datatype}`, fieldId, row);
      }
      if (templated.length > 0) {
        const variables = Object.fromEntries(named.map((f) => [f.columnName!, f.id === meta.timeField ? raw.time : raw.values.get(f.id)]));
        for (const f of templated) {
          if (!raw.values.has(f.id)) continue;
          let iri: string;
          try {
            iri = resolveIri(expandTemplate(f.aboutUrl!, variables), base);
          } catch (error) {
            add('about-url', (error as Error).message, f.id, row);
            continue;
          }
          const other = pointIris.get(iri);
          if (other !== undefined) add('about-url', `the point IRI ${iri} is also the IRI of a point in row ${other}`, f.id, row);
          else pointIris.set(iri, row);
        }
      }
    }
  } catch (error) {
    add('data', `the data could not be read: ${(error as Error).message}`, source.id, row + 1);
  }
}

/** The rules on the points of a `tss:EmbeddedRDFSource`: one reading per point, in the shape of its fields. */
function embeddedRdfRules(source: ReadableSource, add: Add): void {
  const ds: Dataset = source.dataset;
  const meta = source.metadata;
  const timeField = meta.fields.find((f) => f.id === meta.timeField)!;
  const others = meta.fields.filter((f) => f.id !== meta.timeField && f.property);
  const valueFields = others.filter((f) => f.kind === 'value');
  const pointsByTime = new Map<bigint, Set<string>>();
  let index = 0;
  for (const point of objectsOf(ds, source.node, tss('hasPoint'))) {
    index++;
    const where = point.termType === 'NamedNode' ? point.value : undefined;
    const times = timeField.property ? objectsOf(ds, point, timeField.property) : [];
    if (times.length !== 1) add('point-time', `a point has exactly one time (${timeField.property}), not ${times.length}`, where, index);
    else if (!isTimeLiteral(times[0])) add('point-time', `the time of a point is an xsd:dateTime (or xsd:dateTimeStamp) literal with a timezone`, where, index);
    const own = valueFields.filter((f) => objectsOf(ds, point, f.property!).length > 0);
    if (own.length !== 1) add('point-value', `a point has the value of exactly one value field, not ${own.length}`, where, index);
    for (const f of others) {
      const objects = objectsOf(ds, point, f.property!);
      if (objects.length === 0) continue;
      if (objects.length > 1) add('one-value', `a point has at most one value for a field, not ${objects.length}`, f.id, index);
      if (f.kind === 'meta' && !f.describesField.some((target) => own.some((v) => v.id === target))) {
        add('point-value', `a point only states the values of the describing fields of its value field, not of ${f.localName}`, f.id, index);
      }
      for (const o of objects) {
        const datatype = o.termType === 'Literal' ? (o as { datatype?: { value: string } }).datatype?.value : undefined;
        if (o.termType !== 'Literal') add('literal', 'a value of an RDF point is a literal', f.id, index);
        else if (f.datatype !== RDF + 'langString' && datatype !== f.datatype) {
          add('value-datatype', `the datatype of the value is ${datatype}, the field says ${f.datatype}`, f.id, index);
        }
      }
    }
    const instant = times.length === 1 ? tryInstantOf(times[0].value) : null;
    if (instant !== null && own.length === 1) {
      let row = pointsByTime.get(instant);
      if (!row) pointsByTime.set(instant, (row = new Set()));
      if (row.has(own[0].id)) add('unique-point', `two points of ${own[0].localName} have the time ${times[0].value}: a row has at most one point for each value field`, own[0].id, index);
      row.add(own[0].id);
    }
  }
  // a field property that is not stated in the metadata may still be used by a point by mistake: the old shape used the field IRI
  for (const f of meta.fields) {
    if (f.id.startsWith('_:') || f.id === f.property) continue;
    for (const _ of ds.match(null, namedNode(f.id), null, null)) {
      add('field-as-property', `${f.id} is a field, not the property that states its values (${f.property ?? 'tss:property'})`, f.id);
      break;
    }
  }
}
