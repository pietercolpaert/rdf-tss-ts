import { ValidationError } from '../errors.js';
import { formatTime, gridTime, parseDuration, parseTime, type Duration, type ParsedTime } from '../time.js';
import type { FieldMetadata, SnippetMetadata } from '../types.js';

/** A point as read from a source, before the window, the value encoding and units are applied. */
export interface RawPoint {
  /** The time of the point, an `xsd:dateTimeStamp`. */
  time: string;
  /** The lexical value of every field the point has a value for, by field id. */
  values: Map<string, string>;
}

/** Gives the lexical value a row has for a field; `undefined` for an empty value. */
export type RowAccess = (field: FieldMetadata) => string | undefined;

/**
 * Build the function that turns a row of a data file into a point: it finds the time (in
 * a column, or from the step on the time grid) and the values of the other fields.
 */
export function makeRowConverter(meta: SnippetMetadata): (access: RowAccess, row: number) => RawPoint {
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
