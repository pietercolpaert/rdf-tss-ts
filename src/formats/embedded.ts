import { ValidationError } from '../errors.js';
import type { ParsedSource } from '../metadata.js';
import { tss } from '../ns.js';
import type { Dataset, Term } from '../rdf.js';
import { objectOf, objectsOf, termId } from '../rdf.js';
import { tryInstantOf } from '../time.js';
import type { FieldMetadata } from '../types.js';
import type { RawRow } from './rows.js';

function sortByTime(rows: RawRow[]): RawRow[] {
  const keyed = rows.map((row) => {
    const instant = tryInstantOf(row.time);
    if (instant === null) throw new ValidationError(`the time ${JSON.stringify(row.time)} is not a time with a timezone (an xsd:dateTime such as 2024-05-12T08:00:00Z)`);
    return { row, instant };
  });
  keyed.sort((a, b) => (a.instant < b.instant ? -1 : a.instant > b.instant ? 1 : 0));
  return keyed.map((k) => k.row);
}

/**
 * What the points of an embedded RDF source state: every point its value field (`tss:field`,
 * which it may leave out when the source has one value field), its time (`tss:time`) and its
 * reading (`tss:value`); and the values of the describing fields of its value field, each with
 * the field property of the describing field.
 */
export function pointFields(parsed: ParsedSource): {
  time: FieldMetadata;
  valueFields: FieldMetadata[];
  describing: (FieldMetadata & { property: string })[];
} {
  const { metadata } = parsed;
  const time = metadata.fields.find((f) => f.id === metadata.timeField)!;
  const valueFields: FieldMetadata[] = [];
  const describing: (FieldMetadata & { property: string })[] = [];
  for (const f of metadata.fields) {
    if (f.id === metadata.timeField || f.id === metadata.stepField) continue;
    if (f.kind === 'value') valueFields.push(f);
    // a describing field without a property cannot be stated on the points (validate() reports it)
    else if (f.describesField.length > 0 && f.property) describing.push(f as FieldMetadata & { property: string });
  }
  return { time, valueFields, describing };
}

/**
 * The value field of a point: its `tss:field`, or the only value field of the source.
 * `undefined` when it states none and the source has several, or states a field that is not
 * a value field of the source.
 */
export function valueFieldOfPoint(ds: Dataset, point: Term, valueFields: FieldMetadata[]): FieldMetadata | undefined {
  const stated = objectsOf(ds, point, tss('field'));
  if (stated.length === 0) return valueFields.length === 1 ? valueFields[0] : undefined;
  if (stated.length > 1) return undefined;
  return valueFields.find((f) => f.id === termId(stated[0]));
}

/**
 * The rows of a `tss:EmbeddedRDFSource`, ordered by time: its points (one reading of one
 * value field each, with the values of the describing fields) grouped by their time.
 */
export function embeddedRdfRows(ds: Dataset, parsed: ParsedSource): RawRow[] {
  const { valueFields, describing } = pointFields(parsed);
  const rows = new Map<bigint, RawRow>();
  let index = 0;
  for (const node of objectsOf(ds, parsed.term, tss('hasPoint'))) {
    index++;
    const timeValue = objectOf(ds, node, tss('time'));
    if (!timeValue) throw new ValidationError(`point ${index} has no time (tss:time)`);
    const instant = tryInstantOf(timeValue.value);
    if (instant === null) throw new ValidationError(`the time ${JSON.stringify(timeValue.value)} is not a time with a timezone (an xsd:dateTime such as 2024-05-12T08:00:00Z)`);
    const field = valueFieldOfPoint(ds, node, valueFields);
    if (!field) {
      throw new ValidationError(
        `point ${index} ${objectsOf(ds, node, tss('field')).length === 0 ? 'states no tss:field, and the source has several value fields' : 'does not state one value field of the source with tss:field'}`,
      );
    }
    let row = rows.get(instant);
    if (!row) rows.set(instant, (row = { time: timeValue.value, values: new Map(), nodes: new Map() }));
    const reading = objectOf(ds, node, tss('value'));
    if (reading && reading.value !== '' && !row.values.has(field.id)) {
      row.values.set(field.id, reading.value);
      row.nodes!.set(field.id, node as Term);
    }
    for (const d of describing) {
      if (!d.describesField.includes(field.id)) continue;
      const described = objectOf(ds, node, d.property);
      if (described && described.value !== '' && !row.values.has(d.id)) row.values.set(d.id, described.value);
    }
  }
  return sortByTime([...rows.values()]);
}

/** The rows of a `tss:EmbeddedJSONSource`, ordered by time. */
export function embeddedJsonRows(ds: Dataset, parsed: ParsedSource): RawRow[] {
  const { metadata, term } = parsed;
  const literal = objectOf(ds, term, tss('points'));
  if (!literal) return [];
  let json: unknown;
  try {
    json = JSON.parse(literal.value);
  } catch (error) {
    throw new ValidationError(`tss:points is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(json)) throw new ValidationError('tss:points must be a JSON array of objects');
  const timeField = metadata.fields.find((f) => f.id === metadata.timeField)!;
  if (!timeField.columnName) throw new ValidationError('the time field of an embedded JSON source needs a tss:columnName');
  const otherFields = metadata.fields.filter((f) => f.id !== metadata.timeField);
  const rows: RawRow[] = [];
  json.forEach((object, index) => {
    if (typeof object !== 'object' || object === null || Array.isArray(object)) {
      throw new ValidationError(`row ${index + 1} of tss:points is not a JSON object`);
    }
    const record = object as Record<string, unknown>;
    const text = (value: unknown): string | undefined =>
      value === null || value === undefined || value === '' ? undefined : String(value);
    const time = text(record[timeField.columnName!]);
    if (time === undefined) throw new ValidationError(`row ${index + 1} has no time`);
    const values = new Map<string, string>();
    for (const f of otherFields) {
      if (!f.columnName) throw new ValidationError(`field ${f.id} of an embedded JSON source needs a tss:columnName`);
      const value = text(record[f.columnName]);
      if (value !== undefined) values.set(f.id, value);
    }
    rows.push({ time, values });
  });
  return sortByTime(rows);
}
