import { ValidationError } from '../errors.js';
import type { Term } from '../rdf.js';
import { formatTime, gridTime, parseDuration, parseTime, type Duration, type ParsedTime } from '../time.js';
import type { FieldMetadata, SourceMetadata } from '../types.js';

/** A row as read from a source, before the window, the value encoding and units are applied. */
export interface RawRow {
  /** The time of the row, an `xsd:dateTimeStamp`. */
  time: string;
  /** The lexical value of every field the row has a value for, by field id. */
  values: Map<string, string>;
  /** The RDF node of the point of each value field, in an embedded RDF source. */
  nodes?: Map<string, Term>;
}

/** Gives the lexical value a row has for a field; `undefined` for an empty value. */
export type RowAccess = (field: FieldMetadata) => string | undefined;

/**
 * Build the function that turns a row of a data file into a raw row: it finds the time (in
 * a column, or from the step on the time grid) and the values of the other fields.
 */
export function makeRowConverter(meta: SourceMetadata): (access: RowAccess, row: number) => RawRow {
  let grid: { base: ParsedTime; step: Duration } | null = null;
  if (meta.timeBase !== undefined && meta.timeStep !== undefined) {
    const base = parseTime(meta.timeBase);
    const step = parseDuration(meta.timeStep);
    if (!base) throw new ValidationError(`tss:timeBase ${JSON.stringify(meta.timeBase)} is not an xsd:dateTimeStamp`);
    if (!step) throw new ValidationError(`tss:timeStep ${JSON.stringify(meta.timeStep)} is not an xsd:duration`);
    grid = { base, step };
  }
  const timeField = meta.fields.find((f) => f.id === meta.timeField)!;
  const stepField = meta.stepField ? meta.fields.find((f) => f.id === meta.stepField) : undefined;
  if (grid && !stepField) throw new ValidationError('a time grid needs a tss:stepField');
  const valueFields = meta.fields.filter((f) => f.id !== meta.timeField && f.id !== meta.stepField);

  return (access, row) => {
    let time: string | undefined;
    if (grid) {
      const step = access(stepField!);
      if (step === undefined || !/^\d+$/.test(step.trim())) {
        throw new ValidationError(`row ${row} has no valid step (a whole number of 0 or more)`);
      }
      time = formatTime(gridTime(grid.base, grid.step, BigInt(step.trim())));
    } else {
      time = access(timeField);
      if (time === undefined) throw new ValidationError(`row ${row} has no time`);
    }
    const values = new Map<string, string>();
    for (const f of valueFields) {
      const value = access(f);
      if (value !== undefined) values.set(f.id, value);
    }
    return { time, values };
  };
}
