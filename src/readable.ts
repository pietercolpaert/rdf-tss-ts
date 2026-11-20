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
import { parseSource, type ParsedSource } from './metadata.js';
import { tss, xsd } from './ns.js';
import type { Dataset, Quad, Term } from './rdf.js';
import { Row, Value } from './row.js';
import { expansionEnding, expansionHead, toRDFMessages, type ExpandOptions } from './expand.js';
import { arrowRows, parquetRows } from './formats/table.js';
import { collect, openData, type DataContext } from './formats/access.js';
import { csvRows } from './formats/csv.js';
import { embeddedJsonRows, embeddedRdfRows } from './formats/embedded.js';
import type { RawRow } from './formats/rows.js';
import { durationToMs, toInstant, tryInstantOf, type Instant } from './time.js';
import { defaultUnitConverter, type UnitConversion, type UnitConverter } from './units.js';
import type { FieldMetadata, FieldSummary, RDFMessage, ReadOptions, SourceMetadata, SourceKind } from './types.js';

export type Origin = { type: 'http'; url: string } | { type: 'file'; url: string; path: string } | { type: 'dataset' };

export interface SourceContext extends DataContext {
  /** Base IRI to resolve a relative `tss:dataFile` against. */
  baseIRI?: string;
  /** The source IRI to pick when the document has several. */
  source?: string;
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

/** A source that can be read. */
export class ReadableSource {
  protected store: Store;
  protected parsed: ParsedSource;
  protected origin: Origin;
  protected ctx: SourceContext;
  /** The messages of the metadata document when it is an RDF Message Log. */
  protected messages: Quad[][];
  private fieldIndex?: Map<string, FieldMetadata[]>;

  constructor(store: Store, parsed: ParsedSource, origin: Origin, ctx: SourceContext, messages: Quad[][] = []) {
    this.store = store;
    this.parsed = parsed;
    this.origin = origin;
    this.ctx = ctx;
    this.messages = messages;
  }

  /** IRI of the source. */
  get id(): string {
    return this.parsed.metadata.id;
  }

  get kind(): SourceKind {
    return this.parsed.metadata.kind;
  }

  /** The time field, the fields, the time window, `immutable` and labels. */
  get metadata(): SourceMetadata {
    return this.parsed.metadata;
  }

  /** The RDF of the metadata document (and the embedded rows). */
  get dataset(): Dataset {
    return this.store;
  }

  /** The IRI of the metadata document: the base of a relative data file and of the default field properties of an embedded source. */
  get baseIRI(): string | undefined {
    return this.ctx.baseIRI;
  }

  /** The RDF term of the source. */
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

  /** The summary stored in the source for a field (only an immutable source has one). */
  summary(field: string): FieldSummary | undefined {
    return this.resolveField(field).summary;
  }

  /** A report listing every rule of the specification that fails, and where. */
  async validate(): Promise<Report> {
    const { validateSource } = await import('./validate.js');
    return validateSource(this);
  }

  /** The IRI of the data file of an external source, resolved against the metadata document. */
  dataFileIri(): string {
    const dataFile = this.metadata.dataFile;
    if (!dataFile) throw new ValidationError(`source ${this.id} has no tss:dataFile`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(dataFile)) return dataFile;
    if (!this.ctx.baseIRI) throw new ValidationError(`the data file ${JSON.stringify(dataFile)} is relative and there is no base IRI`);
    return new URL(dataFile, this.ctx.baseIRI).href;
  }

  /** Read the metadata document again (ldfetch follows HTTP caching): the description of a growing source only gains `tss:immutable true` and summaries. */
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
    this.parsed = parseSource(store, { source: this.ctx.source ?? this.parsed.metadata.id, baseIRI: this.ctx.baseIRI });
    this.fieldIndex = undefined;
  }

  /** All the rows of the source, as stored: before the time window, value encodings and units are applied. */
  async *rows(options: { skip?: number; strict?: boolean; signal?: AbortSignal } = {}): AsyncIterable<RawRow> {
    const meta = this.metadata;
    const skip = options.skip ?? 0;
    switch (meta.kind) {
      case 'EmbeddedRDF':
        yield* embeddedRdfRows(this.store, this.parsed).slice(skip);
        return;
      case 'EmbeddedJSON':
        yield* embeddedJsonRows(this.store, this.parsed).slice(skip);
        return;
      default: {
        const response = await openData(this.dataFileIri(), this.ctx, { signal: options.signal });
        const params = { skip, strict: options.strict ?? false };
        if (meta.kind === 'CSV') {
          yield* csvRows(meta, response.chunks(), params);
        } else if (meta.kind === 'Arrow') {
          yield* arrowRows(meta, await collect(response.chunks()), params);
        } else {
          yield* parquetRows(meta, await collect(response.chunks()), params);
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

  private decode(field: FieldMetadata, text: string, row: RawRow): string {
    if (field.valueEncoding !== DELTA) return text;
    const baseline = field.baseline !== undefined ? Decimal.parse(field.baseline) : null;
    const delta = Decimal.parse(text);
    if (!baseline || !delta) {
      throw new ValidationError(`cannot decode ${JSON.stringify(text)} of field ${field.id} at ${row.time} against baseline ${field.baseline}`);
    }
    return baseline.add(delta).toString();
  }

  private toRow(plan: Plan, raw: RawRow, state: PassState): Row | null {
    const instant = tryInstantOf(raw.time);
    if (instant === null) throw new ValidationError(`the time ${JSON.stringify(raw.time)} is not a time with a timezone (an xsd:dateTime such as 2024-05-12T08:00:00Z)`);
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
    return new Row(this, raw.time, values, raw.nodes);
  }

  /** The follower of a growing source, or nothing when it cannot be followed (it is in memory). */
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
          (quads) => embeddedRdfRows(new Store(quads), this.parsed),
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
            return { rows: seen.fresh(embeddedJsonRows(this.store, this.parsed)), ended: this.metadata.immutable };
          },
        };
      }
      default:
        return undefined;
    }
  }

  /**
   * Read the rows, in the order they are stored (embedded rows are ordered by time). With
   * `follow`, the existing rows come first, and then new rows as they are added, until the
   * source is immutable, the `until` is reached or the signal aborts.
   */
  async *read(options: ReadOptions = {}): AsyncGenerator<Row> {
    const plan = await this.plan(options);
    const state: PassState = { reachedUntil: false };
    const follower = options.follow && !this.metadata.immutable ? this.createFollower() : undefined;
    if (!follower) {
      for await (const raw of this.rows({ signal: options.signal })) {
        const reading = this.toRow(plan, raw, state);
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
      // an external source states in its metadata that it is immutable: read the data once more, and stop
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
      for (const raw of seen.fresh(result.rows)) {
        const reading = this.toRow(plan, raw, state);
        if (reading) yield reading;
      }
      if (ended || state.reachedUntil || options.signal?.aborted) return;
      await sleep(explicit ?? Math.max(follower.maxAgeMs ?? 10_000, 1000), options.signal);
    }
  }

  /**
   * Expand the source into its points as RDF (spec: "Expanding a source into points"), as RDF
   * messages that follow the RDF Message Stream Profile: a description message with the
   * metadata, without `tss:points`, and the default field properties; one message per row with
   * the points of its value fields; and, when the source is immutable, an ending message with
   * `tss:immutable true` and the stored summaries. With `follow`, the rows that are added later
   * follow, as with `read`, and the ending message when the source is ended.
   */
  async *expand(options: ExpandOptions & Pick<ReadOptions, 'from' | 'until' | 'follow' | 'signal'> = {}): AsyncGenerator<RDFMessage> {
    const { from, until, follow, signal, ...rest } = options;
    if (rest.metadata !== false) yield expansionHead(this, rest);
    yield* toRDFMessages(this.read({ from, until, follow, signal }), { ...rest, metadata: false });
    const ending = rest.metadata !== false ? expansionEnding(this) : undefined;
    if (ending) yield ending;
  }

  /** A short description, for logs. */
  toString(): string {
    return `${this.kind} source ${this.id} (${this.metadata.fields.length} fields)`;
  }
}
