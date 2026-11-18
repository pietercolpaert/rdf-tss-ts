import type { Store } from 'n3';
import { Decimal } from './decimal.js';
import { ValidationError, type Report } from './errors.js';
import { isNumericDatatype } from './lexical.js';
import { parseSnippet, type ParsedSnippet } from './metadata.js';
import { tss, xsd } from './ns.js';
import { localEtag, readLocalText } from './platform.js';
import type { Dataset, Term } from './rdf.js';
import { parseRdf } from './rdf.js';
import { Reading, Value } from './reading.js';
import { arrowPoints, parquetPoints } from './sources/table.js';
import { collect, openData, type DataContext } from './sources/access.js';
import { csvPoints } from './sources/csv.js';
import { embeddedJsonPoints, embeddedRdfPoints } from './sources/embedded.js';
import type { RawPoint } from './sources/rows.js';
import { durationToMs, toInstant, tryInstantOf, type Instant } from './time.js';
import { defaultUnitConverter, type UnitConversion, type UnitConverter } from './units.js';
import type { FieldMetadata, FieldSummary, ReadOptions, SnippetMetadata, SnippetKind } from './types.js';

export type Origin =
  | { type: 'http'; url: string; etag?: string }
  | { type: 'file'; path: string; etag?: string }
  | { type: 'dataset' };

export interface SnippetContext extends DataContext {
  /** Base IRI to resolve a relative `tss:dataFile` against. */
  baseIRI?: string;
  /** The snippet IRI to pick when the document has several. */
  snippet?: string;
  converter?: UnitConverter;
}

const DELTA = tss('DeltaFromBaseline');
export const ACCEPT =
  'text/turtle, application/trig;q=0.9, application/ld+json;q=0.8, application/n-triples;q=0.7, application/n-quads;q=0.7, */*;q=0.1';

interface Plan {
  fields: FieldMetadata[];
  from?: Instant;
  until?: Instant;
  conversions: Map<string, UnitConversion>;
}

interface PassState {
  /** Data rows read so far; the next pass skips them. */
  rows: number;
  reachedUntil: boolean;
  etag?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A snippet that can be read. */
export class ReadableSnippet {
  protected store: Store;
  protected parsed: ParsedSnippet;
  protected origin: Origin;
  protected ctx: SnippetContext;
  private fieldIndex?: Map<string, FieldMetadata[]>;

  constructor(store: Store, parsed: ParsedSnippet, origin: Origin, ctx: SnippetContext) {
    this.store = store;
    this.parsed = parsed;
    this.origin = origin;
    this.ctx = ctx;
  }

  /** IRI of the snippet. */
  get id(): string {
    return this.parsed.metadata.id;
  }

  get kind(): SnippetKind {
    return this.parsed.metadata.kind;
  }

  /** The time field, the fields, the time window, `mutable` and labels. */
  get metadata(): SnippetMetadata {
    return this.parsed.metadata;
  }

  /** The RDF of the metadata document (and the embedded points). */
  get dataset(): Dataset {
    return this.store;
  }

  /** The RDF term of the snippet. */
  get node(): Term {
    return this.parsed.term;
  }

  /** The field a local name or IRI stands for. */
  resolveField(key: string): FieldMetadata {
    const fields = this.parsed.metadata.fields;
    const exact = fields.find((f) => f.id === key);
    if (exact) return exact;
    if (!this.fieldIndex) {
      this.fieldIndex = new Map();
      for (const f of fields) this.fieldIndex.set(f.localName, [...(this.fieldIndex.get(f.localName) ?? []), f]);
    }
    const matches = this.fieldIndex.get(key) ?? [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`the local name ${JSON.stringify(key)} is ambiguous (${matches.map((m) => m.id).join(', ')}); use the IRI`);
    }
    throw new Error(`unknown field ${JSON.stringify(key)}; the fields are ${fields.map((f) => f.localName).join(', ')}`);
  }

  /** The summary stored in the snippet for a field. */
  summary(field: string): FieldSummary | undefined {
    return this.resolveField(field).summary;
  }

  /** A report listing every rule that fails and where. */
  async validate(): Promise<Report> {
    const { validateSnippet } = await import('./validate.js');
    return validateSnippet(this);
  }

  /** The IRI of the data file of an external snippet, resolved against the metadata document. */
  dataFileIri(): string {
    const dataFile = this.metadata.dataFile;
    if (!dataFile) throw new ValidationError(`snippet ${this.id} has no tss:dataFile`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(dataFile)) return dataFile;
    if (!this.ctx.baseIRI) throw new ValidationError(`the data file ${JSON.stringify(dataFile)} is relative and there is no base IRI`);
    return new URL(dataFile, this.ctx.baseIRI).href;
  }

  /** Read the metadata document again; true when it changed. */
  async refresh(signal?: AbortSignal): Promise<boolean> {
    if (this.origin.type === 'http') {
      const headers: Record<string, string> = { Accept: ACCEPT };
      if (this.origin.etag) headers['If-None-Match'] = this.origin.etag;
      const response = await this.ctx.fetch(this.origin.url, { headers, signal });
      if (response.status === 304) return false;
      if (!response.ok) throw new Error(`could not fetch ${this.origin.url}: HTTP ${response.status}`);
      const store = await parseRdf(await response.text(), {
        contentType: response.headers.get('content-type'),
        filename: this.origin.url,
        baseIRI: this.ctx.baseIRI,
      });
      this.replace(store);
      this.origin = { ...this.origin, etag: response.headers.get('etag') ?? undefined };
      return true;
    }
    if (this.origin.type === 'file') {
      const etag = await localEtag(this.origin.path);
      if (etag === this.origin.etag) return false;
      const store = await parseRdf(await readLocalText(this.origin.path), { filename: this.origin.path, baseIRI: this.ctx.baseIRI });
      this.replace(store);
      this.origin = { ...this.origin, etag };
      return true;
    }
    return false;
  }

  protected replace(store: Store): void {
    this.store = store;
    this.parsed = parseSnippet(store, this.ctx.snippet ?? this.parsed.metadata.id);
    this.fieldIndex = undefined;
  }

  /** The points of the snippet after the first `skip` rows, as stored. */
  async *points(options: { skip: number; strict: boolean; state?: PassState; signal?: AbortSignal }): AsyncIterable<RawPoint> {
    const meta = this.metadata;
    switch (meta.kind) {
      case 'EmbeddedRDF':
        yield* embeddedRdfPoints(this.store, this.parsed).slice(options.skip);
        return;
      case 'EmbeddedJSON':
        yield* embeddedJsonPoints(this.store, this.parsed).slice(options.skip);
        return;
      default: {
        const response = await openData(this.dataFileIri(), this.ctx, { etag: options.state?.etag, signal: options.signal });
        if (response.notModified) return;
        if (options.state) options.state.etag = response.etag;
        if (meta.kind === 'CSV') {
          yield* csvPoints(meta, response.chunks(), options);
        } else if (meta.kind === 'Arrow') {
          yield* arrowPoints(meta, await collect(response.chunks()), options);
        } else {
          yield* parquetPoints(meta, await collect(response.chunks()), options);
        }
      }
    }
  }

  private async plan(options: ReadOptions): Promise<Plan> {
    const meta = this.metadata;
    const skip = new Set([meta.timeField, meta.stepField]);
    let fields = meta.fields.filter((f) => !skip.has(f.id));
    if (options.fields) {
      const wanted = new Set(options.fields.map((key) => this.resolveField(key).id));
      fields = fields.filter((f) => wanted.has(f.id));
    }
    const plan: Plan = { fields, conversions: new Map() };
    if (options.from !== undefined) plan.from = toInstant(options.from);
    if (options.until !== undefined) plan.until = toInstant(options.until);

    const unit = options.unit ?? 'source';
    if (unit !== 'source') {
      const converter = this.ctx.converter ?? defaultUnitConverter();
      for (const f of fields) {
        if (f.unit && isNumericDatatype(f.datatype)) plan.conversions.set(f.id, await converter.conversion(f.unit, unit));
      }
    }
    return plan;
  }

  private decode(field: FieldMetadata, text: string, row: RawPoint): string {
    if (field.valueEncoding !== DELTA) return text;
    const baseline = field.baseline !== undefined ? Decimal.parse(field.baseline) : null;
    const delta = Decimal.parse(text);
    if (!baseline || !delta) {
      throw new ValidationError(`cannot decode ${JSON.stringify(text)} of field ${field.id} at ${row.time} against baseline ${field.baseline}`);
    }
    return baseline.add(delta).toString();
  }

  private toReading(plan: Plan, raw: RawPoint, state: PassState): Reading | null {
    const instant = tryInstantOf(raw.time);
    if (instant === null) throw new ValidationError(`the time ${JSON.stringify(raw.time)} is not an xsd:dateTimeStamp`);
    const meta = this.metadata;
    if (meta.from && instant < toInstant(meta.from)) return null;
    if (meta.until && instant >= toInstant(meta.until)) return null;
    if (plan.from !== undefined && instant < plan.from) return null;
    if (plan.until !== undefined && instant >= plan.until) {
      state.reachedUntil = true;
      return null;
    }
    const values = new Map<string, Value>();
    for (const f of plan.fields) {
      const text = raw.values.get(f.id);
      if (text === undefined) continue;
      const decoded = this.decode(f, text, raw);
      const conversion = plan.conversions.get(f.id);
      if (conversion) {
        const number = Number(decoded);
        if (!Number.isFinite(number)) {
          values.set(f.id, new Value(decoded, f.datatype, f.unit));
        } else {
          values.set(f.id, new Value(String(conversion.convert(number)), xsd('double'), conversion.unit));
        }
      } else {
        values.set(f.id, new Value(decoded, f.datatype, f.unit));
      }
    }
    return new Reading(this, raw.time, values);
  }

  private async *pass(plan: Plan, state: PassState, strict: boolean, signal?: AbortSignal): AsyncGenerator<Reading> {
    for await (const raw of this.points({ skip: state.rows, strict, state, signal })) {
      if (strict && this.metadata.until) {
        // A writer adds the data before it widens the window: a point after the window is
        // not yet announced, so wait for the next poll instead of skipping it for good.
        const instant = tryInstantOf(raw.time);
        if (instant !== null && instant >= toInstant(this.metadata.until)) {
          state.etag = undefined;
          return;
        }
      }
      state.rows++;
      const reading = this.toReading(plan, raw, state);
      if (reading) yield reading;
    }
  }

  /**
   * Read the points as readings, in the order they are stored (embedded points are ordered
   * by time). With `follow`, the existing points come first, and then new points as they are
   * added, until the snippet is immutable, the `until` is reached or the signal aborts.
   */
  async *read(options: ReadOptions = {}): AsyncGenerator<Reading> {
    const plan = await this.plan(options);
    const state: PassState = { rows: 0, reachedUntil: false };
    if (!options.follow) {
      yield* this.pass(plan, state, false, options.signal);
      return;
    }
    const interval = typeof options.follow === 'object' && options.follow.interval ? durationToMs(options.follow.interval) : 10_000;
    for (let round = 0; ; round++) {
      if (options.signal?.aborted) return;
      if (round > 0) await this.refresh(options.signal);
      yield* this.pass(plan, state, this.metadata.mutable, options.signal);
      if (!this.metadata.mutable || state.reachedUntil || options.signal?.aborted) return;
      await sleep(interval, options.signal);
    }
  }

  /** A short description, for logs. */
  toString(): string {
    return `${this.kind} snippet ${this.id} (${this.metadata.fields.length} fields)`;
  }
}
