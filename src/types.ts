import type { SnippetKind } from './ns.js';
import type { Reading } from './reading.js';

export type { SnippetKind };

/** The numbers a snippet stores about one field. */
export interface FieldSummary {
  missingValuePolicy?: string;
  count?: number;
  missing?: number;
  firstTime?: string;
  lastTime?: string;
  observedMinimum?: string;
  observedMaximum?: string;
  mean?: string;
  median?: string;
  generatedAtTime?: string;
}

/** What the metadata says about one field (column) of a snippet. */
export interface FieldMetadata {
  /** IRI of the field (`_:label` for a blank node). */
  id: string;
  /** The part of the IRI after the last `#` or `/`: the short way to name the field. */
  localName: string;
  labels: string[];
  /** Datatype IRI of the values. */
  datatype: string;
  language?: string;
  columnName?: string;
  columnIndex?: number;
  observedProperty?: string;
  unit?: string;
  sensor?: string;
  featureOfInterest?: string;
  /** IRIs of the fields this field says something about. */
  describesField: string[];
  minimum?: string;
  maximum?: string;
  valueEncoding?: string;
  baseline?: string;
  summary?: FieldSummary;
}

/** What the metadata says about a snippet. */
export interface SnippetMetadata {
  id: string;
  kind: SnippetKind;
  labels: string[];
  mutable: boolean;
  /** Start of the time window (included), as written. */
  from?: string;
  /** End of the time window (excluded), as written. */
  until?: string;
  committedUntil?: string;
  /** IRI of the time field. */
  timeField: string;
  /** IRI of the step field of a time grid. */
  stepField?: string;
  timeBase?: string;
  timeStep?: string;
  /** All fields, including the time field. */
  fields: FieldMetadata[];
  dataFile?: string;
  delimiter: string;
  encoding: string;
  header: boolean;
  producedBy?: string;
}

/** Options of `read()`. */
export interface ReadOptions {
  /** Included; an `xsd:dateTimeStamp` or a `Date`. Default: the start of the snippet. */
  from?: string | Date;
  /** Excluded; an `xsd:dateTimeStamp` or a `Date`. Default: the end of the snippet. */
  until?: string | Date;
  /** Fields to include, by local name or IRI. Default: all. */
  fields?: string[];
  /** `'source'` (default), `'qudt'` (the QUDT normalized unit) or a unit IRI. */
  unit?: 'source' | 'qudt' | (string & {});
  /** Keep polling for new points: `true` or `{ interval }`, an `xsd:duration` such as `'PT30S'`. */
  follow?: boolean | { interval?: string };
  signal?: AbortSignal;
}

/** A reading to append: a time and the values of some fields. */
export interface ReadingInput {
  /** An `xsd:dateTimeStamp` (with timezone), or a `Date`. */
  time: string | Date;
  /** Values by field local name or IRI. A field left out or `null` has no value. */
  values: Record<string, string | number | bigint | boolean | null | undefined>;
}

export interface CreateField {
  id: string;
  columnName?: string;
  columnIndex?: number;
  /** Default `xsd:decimal`. */
  datatype?: string;
  label?: string;
  observedProperty?: string;
  unit?: string;
  sensor?: string;
  featureOfInterest?: string;
  describesField?: string;
  minimum?: string | number;
  maximum?: string | number;
}

export interface CreateOptions {
  id: string;
  kind: SnippetKind;
  /** Path of the data file of an external snippet. */
  dataFile?: string;
  csv?: { delimiter?: string; encoding?: string; header?: boolean };
  /** Default `true`. Parquet snippets are always frozen when they are closed. */
  mutable?: boolean;
  label?: string;
  from?: string;
  until?: string;
  timeField: { id: string; columnName?: string; columnIndex?: number };
  fields: CreateField[];
  /** Keep a stored summary of every numeric field. Default `true`. */
  summaries?: boolean;
  /** Prefixes to abbreviate IRIs with when the metadata is written as Turtle. */
  prefixes?: Record<string, string>;
  /**
   * Path of the metadata file. When given, it is written on creation and after every
   * `append`; the lock is taken on it.
   */
  file?: string;
}

/** A message with the RDF of one reading. */
export interface RDFMessage {
  quads: import('@rdfjs/types').Quad[];
  serialize(mediaType?: string, prefixes?: Record<string, string>): Promise<string>;
}

export type { Reading };
