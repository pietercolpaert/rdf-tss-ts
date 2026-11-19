import { Store } from 'n3';
import { Decimal } from './decimal.js';
import { ValidationError, type Report } from './errors.js';
import {
  ArrowFollower,
  ByteSource,
  CsvFollower,
  RdfLogFollower,
  Seen,
  type Follower,
  type PollResult,
} from './follow.js';
import { isNumericDatatype } from './lexical.js';
import { loadDocument, type RdfLoader } from './loader.js';
import { parseSnippet, type ParsedSnippet } from './metadata.js';
import { tss, xsd } from './ns.js';
import type { Dataset, Quad, Term } from './rdf.js';
import { Reading, Value } from './reading.js';
import { arrowPoints, parquetPoints } from './sources/table.js';
import { collect, openData, type DataContext } from './sources/access.js';
import { csvPoints } from './sources/csv.js';
import { embeddedJsonPoints, embeddedRdfPoints } from './sources/embedded.js';
import type { RawPoint } from './sources/rows.js';
import { durationToMs, toInstant, tryInstantOf, type Instant } from './time.js';
import { defaultUnitConverter, type UnitConversion, type UnitConverter } from './units.js';
import type { FieldMetadata, FieldSummary, ReadOptions, SnippetMetadata, SnippetKind } from './types.js';

export type Origin = { type: 'http'; url: string } | { type: 'file'; url: string; path: string } | { type: 'dataset' };

export interface SnippetContext extends DataContext {
  /** Base IRI to resolve a relative `tss:dataFile` against. */
  baseIRI?: string;
  /** The snippet IRI to pick when the document has several. */
  snippet?: string;
  converter?: UnitConverter;
  /** Reads the metadata document: ldfetch. */
  loader?: RdfLoader;
  headers?: Record<string, string>;
}

const DELTA = tss('DeltaFromBaseline');

interface Plan {
  fields: FieldMetadata[];
  from?: Instant;
  until?: Instant;
  conversions: Map<string, UnitConversion>;
}

interface PassState {
  reachedUntil: boolean;
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

const isTrue = (value: string | undefined) => value === 'true' || value === '1';

/** A snippet that can be read. */
export class ReadableSnippet {
  protected store: Store;
  protected parsed: ParsedSnippet;
  protected origin: Origin;
  protected ctx: SnippetContext;
  /** The messages of the metadata document when it is an RDF Message Log. */
  protected messages: Quad[][];
  private fieldIndex?: Map<string, FieldMetadata[]>;

  constructor(store: Store, parsed: ParsedSnippet, origin: Origin, ctx: SnippetContext, messages: Quad[][] = []) {
    this.store = store;
    this.parsed = parsed;
    this.origin = origin;
    this.ctx = ctx;
    this.messages = messages;
  }

  /** IRI of the snippet. */
  get id(): string {
    return this.parsed.metadata.id;
  }

  get kind(): SnippetKind {
    return this.parsed.metadata.kind;
  }

  /** The time field, the fields, the time window, `immutable` and labels. */
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

  /** The summary stored in the snippet for a field (only an immutable snippet has one). */
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

  /** Read the metadata document again (ldfetch follows HTTP caching): the description of a growing snippet only gains `tss:immutable true` and summaries. */
  async refresh(): Promise<void> {
    if (this.origin.type === 'dataset') return;
    const document = await loadDocument(this.origin.url, {
      loader: this.ctx.loader,
      localFiles: this.origin.type === 'file',
      headers: this.ctx.headers,
    });
    this.replace(document.store, document.messages);
  }

  protected replace(store: Store, messages?: Quad[][]): void {
    this.store = store;
    if (messages) this.messages = messages;
    this.parsed = parseSnippet(store, this.ctx.snippet ?? this.parsed.metadata.id);
    this.fieldIndex = undefined;
  }

  /** All the points of the snippet, as stored. */
  async *points(options: { skip?: number; strict?: boolean; signal?: AbortSignal } = {}): AsyncIterable<RawPoint> {
    const meta = this.metadata;
    const skip = options.skip ?? 0;
    switch (meta.kind) {
      case 'EmbeddedRDF':
        yield* embeddedRdfPoints(this.store, this.parsed).slice(skip);
        return;
      case 'EmbeddedJSON':
        yield* embeddedJsonPoints(this.store, this.parsed).slice(skip);
        return;
      default: {
        const response = await openData(this.dataFileIri(), this.ctx, { signal: options.signal });
        const params = { skip, strict: options.strict ?? false };
        if (meta.kind === 'CSV') {
          yield* csvPoints(meta, response.chunks(), params);
        } else if (meta.kind === 'Arrow') {
          yield* arrowPoints(meta, await collect(response.chunks()), params);
        } else {
          yield* parquetPoints(meta, await collect(response.chunks()), params);
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

    const choice = options.unit ?? 'source';
    // one unit for every field, or a unit per field (by local name or IRI)
    const perField = new Map<string, string>();
    if (typeof choice === 'object') for (const [key, unit] of Object.entries(choice)) perField.set(this.resolveField(key).id, unit);
    const converter = this.ctx.converter ?? defaultUnitConverter();
    for (const f of fields) {
      const unit = typeof choice === 'string' ? choice : (perField.get(f.id) ?? 'source');
      if (unit !== 'source' && f.unit && isNumericDatatype(f.datatype)) plan.conversions.set(f.id, await converter.conversion(f.unit, unit));
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

  /** The follower of a growing snippet, or nothing when it cannot be followed (it is in memory). */
  private createFollower(): Follower | undefined {
    if (this.origin.type === 'dataset') return undefined;
    const meta = this.metadata;
    switch (meta.kind) {
      case 'CSV':
        return new CsvFollower(meta, new ByteSource(this.dataFileIri(), this.ctx));
      case 'Arrow':
        return new ArrowFollower(meta, new ByteSource(this.dataFileIri(), this.ctx));
      case 'EmbeddedRDF': {
        const id = this.id;
        return new RdfLogFollower(
          new ByteSource(this.origin.url, this.ctx),
          this.ctx.baseIRI,
          (quads) => embeddedRdfPoints(new Store(quads), this.parsed),
          (quads) =>
            quads.some(
              (q) =>
                q.subject.value === id &&
                ((q.predicate.value === tss('immutable') && isTrue(q.object.value)) || (q.predicate.value === tss('mutable') && !isTrue(q.object.value))),
            ),
        );
      }
      case 'EmbeddedJSON': {
        const seen = new Seen();
        return {
          poll: async (): Promise<PollResult> => {
            await this.refresh();
            return { points: seen.fresh(embeddedJsonPoints(this.store, this.parsed)), ended: this.metadata.immutable };
          },
        };
      }
      default:
        return undefined;
    }
  }

  /**
   * Read the points as readings, in the order they are stored (embedded points are ordered
   * by time). With `follow`, the existing points come first, and then new points as they are
   * added, until the snippet is immutable, the `until` is reached or the signal aborts.
   */
  async *read(options: ReadOptions = {}): AsyncGenerator<Reading> {
    const plan = await this.plan(options);
    const state: PassState = { reachedUntil: false };
    const follower = options.follow && !this.metadata.immutable ? this.createFollower() : undefined;
    if (!follower) {
      for await (const raw of this.points({ signal: options.signal })) {
        const reading = this.toReading(plan, raw, state);
        if (reading) yield reading;
      }
      return;
    }

    const explicit = typeof options.follow === 'object' && options.follow.interval ? durationToMs(options.follow.interval) : undefined;
    const seen = new Seen();
    const embedded = this.metadata.kind === 'EmbeddedRDF' || this.metadata.kind === 'EmbeddedJSON';
    for (let round = 0; ; round++) {
      if (options.signal?.aborted) return;
      let ended = false;
      // an external snippet states in its metadata that it is immutable: read the data once more, and stop
      if (round > 0 && !embedded) {
        await this.refresh();
        ended = this.metadata.immutable;
      }
      const result = await follower.poll(options.signal);
      if (result.quads) {
        if (result.replaced) this.replace(new Store(result.quads));
        else {
          this.store.addQuads(result.quads);
          this.replace(this.store);
        }
      }
      if (embedded) ended = result.ended || this.metadata.immutable;
      else if (result.ended) ended = true;
      for (const raw of seen.fresh(result.points)) {
        const reading = this.toReading(plan, raw, state);
        if (reading) yield reading;
      }
      if (ended || state.reachedUntil || options.signal?.aborted) return;
      await sleep(explicit ?? Math.max(follower.maxAgeMs ?? 10_000, 1000), options.signal);
    }
  }

  /** A short description, for logs. */
  toString(): string {
    return `${this.kind} snippet ${this.id} (${this.metadata.fields.length} fields)`;
  }
}
