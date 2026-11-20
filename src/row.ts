import { toNativeValue } from './lexical.js';
import type { Term } from './rdf.js';
import type { ReadableSource } from './readable.js';

/** One value of a row: its text, datatype and unit. */
export class Value {
  constructor(
    /** The lexical form. The exact published text when the unit is `'source'`. */
    readonly value: string,
    /** The datatype IRI. */
    readonly datatype: string,
    /** The unit IRI, after any conversion. */
    readonly unit?: string,
  ) {}

  /** The value as a JavaScript value: a number (or `bigint` beyond 2^53), boolean, `Date` or string. */
  toNative(): number | bigint | boolean | Date | string {
    return toNativeValue(this.datatype, this.value);
  }

  toString(): string {
    return this.value;
  }
}

/**
 * One row of a source: its time and the values of its fields. Each value of a value field
 * is one reading, a point; the values of context fields give the context of the row or its points.
 */
export class Row {
  constructor(
    /** The source this row comes from. */
    readonly source: ReadableSource,
    /** The time as published: an `xsd:dateTime` with a timezone. */
    readonly time: string,
    private readonly values: Map<string, Value>,
    /** @internal The RDF node of the point of each value field, in an embedded RDF source. */
    readonly nodes?: Map<string, Term>,
  ) {}

  /** The value of a field, by local name or IRI. `undefined` means there is no value. */
  get(field: string): Value | undefined {
    return this.values.get(this.source.resolveField(field).id);
  }

  /** The values of this row, by field IRI. */
  fields(): Iterable<[string, Value]> {
    return this.values.entries();
  }

  toJSON(): { time: string; values: Record<string, string> } {
    return { time: this.time, values: Object.fromEntries([...this.values].map(([id, v]) => [id, v.value])) };
  }
}
