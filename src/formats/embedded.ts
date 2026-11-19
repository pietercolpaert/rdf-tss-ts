import { ValidationError } from '../errors.js';
import type { ParsedSource } from '../metadata.js';
import { tss } from '../ns.js';
import type { Dataset, Term } from '../rdf.js';
import { namedNode, objectOf, objectsOf } from '../rdf.js';
import { tryInstantOf } from '../time.js';
import type { FieldMetadata } from '../types.js';
import type { RawRow } from './rows.js';

function sortByTime(rows: RawRow[]): RawRow[] {
  const keyed = rows.map((row) => {
    const instant = tryInstantOf(row.time);
    if (instant === null) throw new ValidationError(`the time ${JSON.stringify(row.time)} is not an xsd:dateTimeStamp`);
    return { row, instant };
  });
  keyed.sort((a, b) => (a.instant < b.instant ? -1 : a.instant > b.instant ? 1 : 0));
  return keyed.map((k) => k.row);
}

/** The fields whose values a point of an embedded RDF source can state, with their field property. */
export function pointFields(parsed: ParsedSource): { time: FieldMetadata & { property: string }; fields: (FieldMetadata & { property: string })[] } {
  const { metadata } = parsed;
  const time = metadata.fields.find((f) => f.id === metadata.timeField)!;
  const fields: (FieldMetadata & { property: string })[] = [];
  for (const f of metadata.fields) {
    if (f.id === metadata.timeField || f.id === metadata.stepField) continue;
    if (f.kind === 'meta' && f.describesField.length === 0) continue;
    if (!f.property) {
      throw new ValidationError(
        `field ${f.id} states no tss:property, so its property is <base#columnName>: ${f.columnName === undefined ? 'it needs a tss:columnName' : 'the document has no base IRI to make it with'}`,
      );
    }
    fields.push(f as FieldMetadata & { property: string });
  }
  return { time: time as FieldMetadata & { property: string }, fields };
}

/**
 * The rows of a `tss:EmbeddedRDFSource`, ordered by time: its points (one reading of one
 * value field each, with the values of the describing fields) grouped by their time.
 */
export function embeddedRdfRows(ds: Dataset, parsed: ParsedSource): RawRow[] {
  const { time, fields } = pointFields(parsed);
  const rows = new Map<bigint, RawRow>();
  let index = 0;
  for (const node of objectsOf(ds, parsed.term, tss('hasPoint'))) {
    index++;
    const timeValue = objectOf(ds, node, time.property);
    if (!timeValue) throw new ValidationError(`point ${index} has no time (${time.property})`);
    const instant = tryInstantOf(timeValue.value);
    if (instant === null) throw new ValidationError(`the time ${JSON.stringify(timeValue.value)} is not an xsd:dateTimeStamp`);
    let row = rows.get(instant);
    if (!row) rows.set(instant, (row = { time: timeValue.value, values: new Map(), nodes: new Map() }));
    for (const f of fields) {
      for (const q of ds.match(node, namedNode(f.property), null, null)) {
        if (q.object.value !== '' && !row.values.has(f.id)) {
          row.values.set(f.id, q.object.value);
          if (f.kind === 'value') row.nodes!.set(f.id, node as Term);
        }
        break;
      }
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
