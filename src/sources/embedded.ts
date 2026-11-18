import { ValidationError } from '../errors.js';
import type { ParsedSnippet } from '../metadata.js';
import { tss } from '../ns.js';
import type { Dataset } from '../rdf.js';
import { namedNode, objectOf, objectsOf } from '../rdf.js';
import { tryInstantOf } from '../time.js';
import type { RawPoint } from './rows.js';

function sortByTime(points: RawPoint[]): RawPoint[] {
  const keyed = points.map((point) => {
    const instant = tryInstantOf(point.time);
    if (instant === null) throw new ValidationError(`the time ${JSON.stringify(point.time)} is not an xsd:dateTimeStamp`);
    return { point, instant };
  });
  keyed.sort((a, b) => (a.instant < b.instant ? -1 : a.instant > b.instant ? 1 : 0));
  return keyed.map((k) => k.point);
}

/** The points of a `tss:EmbeddedRDFSnippet`, ordered by time. */
export function embeddedRdfPoints(ds: Dataset, parsed: ParsedSnippet): RawPoint[] {
  const { metadata, term, fieldTerms } = parsed;
  const timeTerm = fieldTerms.get(metadata.timeField)!;
  if (timeTerm.termType !== 'NamedNode') throw new ValidationError('the fields of an embedded RDF snippet must be IRIs');
  const valueFields = metadata.fields.filter((f) => f.id !== metadata.timeField);
  const points: RawPoint[] = [];
  let row = 0;
  for (const node of objectsOf(ds, term, tss('hasPoint'))) {
    row++;
    const time = objectOf(ds, node, timeTerm.value);
    if (!time) throw new ValidationError(`point ${row} has no time`);
    const values = new Map<string, string>();
    for (const f of valueFields) {
      const fieldTerm = fieldTerms.get(f.id)!;
      if (fieldTerm.termType !== 'NamedNode') throw new ValidationError('the fields of an embedded RDF snippet must be IRIs');
      const value = ds.match(node, namedNode(fieldTerm.value), null, null);
      for (const q of value) {
        if (q.object.value !== '') values.set(f.id, q.object.value);
        break;
      }
    }
    points.push({ time: time.value, values });
  }
  return sortByTime(points);
}

/** The points of a `tss:EmbeddedJSONSnippet`, ordered by time. */
export function embeddedJsonPoints(ds: Dataset, parsed: ParsedSnippet): RawPoint[] {
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
  if (!timeField.columnName) throw new ValidationError('the time field of an embedded JSON snippet needs a tss:columnName');
  const valueFields = metadata.fields.filter((f) => f.id !== metadata.timeField);
  const points: RawPoint[] = [];
  json.forEach((object, index) => {
    if (typeof object !== 'object' || object === null || Array.isArray(object)) {
      throw new ValidationError(`point ${index + 1} of tss:points is not a JSON object`);
    }
    const record = object as Record<string, unknown>;
    const text = (value: unknown): string | undefined =>
      value === null || value === undefined || value === '' ? undefined : String(value);
    const time = text(record[timeField.columnName!]);
    if (time === undefined) throw new ValidationError(`point ${index + 1} has no time`);
    const values = new Map<string, string>();
    for (const f of valueFields) {
      if (!f.columnName) throw new ValidationError(`field ${f.id} of an embedded JSON snippet needs a tss:columnName`);
      const value = text(record[f.columnName]);
      if (value !== undefined) values.set(f.id, value);
    }
    points.push({ time, values });
  });
  return sortByTime(points);
}
