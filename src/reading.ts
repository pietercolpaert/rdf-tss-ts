import { toNativeValue } from './lexical.js';
import type { ReadableSnippet } from './readable.js';

/** One value of a reading: its text, datatype and unit. */
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

/** One point of a snippet: its time and the values of its fields. */
export class Reading {
  constructor(
    /** The snippet this reading comes from. */
    readonly snippet: ReadableSnippet,
    /** The time as published: an `xsd:dateTimeStamp`. */
    readonly time: string,
    private readonly values: Map<string, Value>,
  ) {}

  /** The value of a field, by local name or IRI. `undefined` means there is no value. */
  get(field: string): Value | undefined {
    return this.values.get(this.snippet.resolveField(field).id);
  }

  /** The values of this reading, by field IRI. */
  fields(): Iterable<[string, Value]> {
    return this.values.entries();
  }

  toJSON(): { time: string; values: Record<string, string> } {
    return { time: this.time, values: Object.fromEntries([...this.values].map(([id, v]) => [id, v.value])) };
  }
}
