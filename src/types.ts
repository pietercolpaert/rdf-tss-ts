import type { SourceKind } from './ns.js';
import type { Row } from './row.js';

export type { SourceKind };

/** The numbers a source stores about one field. */
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

/**
 * Whether the values of a field are readings (`tss:ValueField`: each value is a point) or
 * say something about a row or its points (`tss:MetaField`: the time field, the step field,
 * a describing field, an identifier, …).
 */
export type FieldKind = 'value' | 'meta';

/** What the metadata says about one field (column) of a source. */
export interface FieldMetadata {
  /** IRI of the field (`_:label` for a blank node). */
  id: string;
  /** The part of the IRI after the last `#` or `/`: the short way to name the field. */
  localName: string;
  /**
   * `tss:ValueField` or `tss:MetaField`. A field that states neither is read as a meta field
   * when it is the time field, the step field or a describing field, else as a value field
   * (and `validate()` reports it).
   */
  kind: FieldKind;
  labels: string[];
  /** Datatype IRI of the values. */
  datatype: string;
  language?: string;
  columnName?: string;
  columnIndex?: number;
  /**
   * The field property: the RDF property that states the values of the field, in the points
   * of an embedded RDF source and in the expansion. Its `tss:property`, or else the default:
   * `tss:time` for the time field, and otherwise `<base#columnName>`, with the data file
   * (external) or the metadata document (embedded) as base. `undefined` when there is no
   * base IRI to make the default with.
   */
  property?: string;
  /** `true` when the property is the default one, made by the specification, not stated with `tss:property`. */
  defaultProperty: boolean;
  /** A URI template (`tss:aboutUrl`) that makes the IRI of each point of a value field. */
  aboutUrl?: string;
  observedProperty?: string;
  unit?: string;
  sensor?: string;
  featureOfInterest?: string;
  /** IRIs of the value fields this (meta) field says something about. */
  describesField: string[];
  minimum?: string;
  maximum?: string;
  valueEncoding?: string;
  baseline?: string;
  summary?: FieldSummary;
}

/** What the metadata says about a source. */
export interface SourceMetadata {
  id: string;
  kind: SourceKind;
  labels: string[];
  /**
   * `true` when no row is added any more (`tss:immutable true`). A source that is not
   * immutable is growing: rows may still be added at its end.
   */
  immutable: boolean;
  /** Start of the time window (included), as written. */
  from?: string;
  /** End of the time window (excluded), as written. */
  until?: string;
  /** IRI of the time field. */
  timeField: string;
  /** IRI of the step field of a time grid. */
  stepField?: string;
  timeBase?: string;
  timeStep?: string;
  /** All fields, including the time field. */
  fields: FieldMetadata[];
  /** The data file as written (it may be relative); see `dataFileIri()` for the resolved IRI. */
  dataFile?: string;
  delimiter: string;
  encoding: string;
  header: boolean;
  producedBy?: string;
}

/** The unit to read a field in: as published, QUDT normalized, or a unit IRI. */
export type UnitChoice = 'source' | 'qudt' | (string & {});

/** Options of `read()`. */
export interface ReadOptions {
  /** Included; an `xsd:dateTime` with a timezone, or a `Date`. Default: the start of the source. */
  from?: string | Date;
  /** Excluded; an `xsd:dateTime` with a timezone, or a `Date`. Default: the end of the source. */
  until?: string | Date;
  /** Fields to include, by local name or IRI. Default: all. */
  fields?: string[];
  /**
   * `'source'` (default), `'qudt'` (the QUDT normalized unit) or a unit IRI, for every field with a
   * unit; or an object with a unit per field (local name or IRI), where a field that is left out
   * stays as published. A single unit IRI throws for a field of another dimension: use an object.
   */
  unit?: UnitChoice | Record<string, UnitChoice>;
  /** Keep polling for new rows: `true` or `{ interval }`, an `xsd:duration` such as `'PT30S'`. Default: the `max-age` of the server, else 10 seconds. */
  follow?: boolean | { interval?: string };
  signal?: AbortSignal;
}

/** A row to append: a time and the values of some fields. */
export interface RowInput {
  /** An `xsd:dateTime` with a timezone, or a `Date`. */
  time: string | Date;
  /** Values by field local name or IRI. A field left out or `null` has no value. */
  values: Record<string, string | number | bigint | boolean | null | undefined>;
}

export interface CreateField {
  id: string;
  /**
   * `'value'` (`tss:ValueField`, its values are readings) or `'meta'` (`tss:MetaField`).
   * Default: `'meta'` for a field with `describesField`, else `'value'`.
   */
  kind?: FieldKind;
  columnName?: string;
  columnIndex?: number;
  /**
   * The RDF property that states the values (`tss:property`). Without it, the field gets the
   * default property `<base#columnName>`. A property you state keeps the meaning of its own
   * vocabulary: add `<property> rdfs:subPropertyOf tss:value` to align its readings.
   */
  property?: string;
  /** A URI template (`tss:aboutUrl`) for the IRI of each point of a value field, e.g. `'obs/temp/{time}'`. */
  aboutUrl?: string;
  /** Default `xsd:decimal`. */
  datatype?: string;
  label?: string;
  observedProperty?: string;
  unit?: string;
  sensor?: string;
  featureOfInterest?: string;
  /** The value field(s) this meta field says something about. */
  describesField?: string | string[];
  minimum?: string | number;
  maximum?: string | number;
}

export interface CreateOptions {
  id: string;
  kind: SourceKind;
  /** Path of the data file of an external source. */
  dataFile?: string;
  csv?: { delimiter?: string; encoding?: string; header?: boolean };
  /**
   * Start with `tss:immutable true`: no row can be added. Default `false`: a growing
   * source. Parquet sources are always immutable, from the moment they are closed.
   */
  immutable?: boolean;
  label?: string;
  /** The time window of a growing source is fixed: every row has to lie in it. */
  from?: string;
  until?: string;
  timeField: { id: string; columnName?: string; columnIndex?: number; property?: string };
  fields: CreateField[];
  /** Add a stored summary of every field when the source is ended. Default `true`. */
  summaries?: boolean;
  /** Prefixes to abbreviate IRIs with when the metadata is written as Turtle. */
  prefixes?: Record<string, string>;
  /**
   * Path of the metadata file. When given, it is written on creation, and kept up to date
   * as the specification allows (see `append` and `close`); the lock is taken on it.
   */
  file?: string;
  /**
   * The IRI of the metadata document, the base of the default field properties of an
   * embedded source. Default: the IRI of `file`, else the source IRI without its fragment.
   */
  baseIRI?: string;
}

/** A message of RDF: the description of a source, or the points of one row. */
export interface RDFMessage {
  quads: import('@rdfjs/types').Quad[];
  serialize(mediaType?: string, prefixes?: Record<string, string>): Promise<string>;
}

export type { Row };
