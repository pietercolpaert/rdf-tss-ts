import type { Store } from 'n3';
import { Decimal } from './decimal.js';
import { LockError, NotWritableError, ValidationError, makeReport, type ReportEntry } from './errors.js';
import { isValidLexical, numberToLexical } from './lexical.js';
import type { ParsedSource } from './metadata.js';
import { pointFields } from './formats/embedded.js';
import { RDF, tss, xsd } from './ns.js';
import { acquireLock, appendLocal, localChunks, readHead, writeFileAtomic } from './platform.js';
import type { Quad, Term } from './rdf.js';
import { blankNode, literal, namedNode, objectOf, quad, serializeMessages, serializeMessagesTail, serializeRdf } from './rdf.js';
import type { NamedNode } from './rdf.js';
import { ReadableSource, type Origin, type SourceContext } from './readable.js';
import { decodeChunks } from './formats/access.js';
import { parseCsv } from './formats/csv.js';
import { formatInstant, formatTime, gridTime, instantOf, parseDuration, parseTime, toInstant, type Instant } from './time.js';
import type { FieldMetadata, RowInput } from './types.js';
import { csvLine } from './writers/csv.js';
import { FieldStats } from './writers/summary.js';
import { EOS_BYTES, arrowStreamBytes, endsWithEos, parquetBytes, recordBatchMessages, tableColumns } from './writers/tables.js';

const DELTA = tss('DeltaFromBaseline');
const NS_PER_SECOND = 1_000_000_000n;

interface NormalizedRow {
  time: string;
  instant: Instant;
  /** Values as the user gave them. */
  values: Map<string, string>;
}

export interface WriterSetup {
  /** The metadata file: written when the source is created, and where the specification allows a change. */
  metadataFile?: string;
  /** The local file with the rows of an external source. */
  dataPath?: string;
  /** A new source: its data file does not exist yet. */
  fresh: boolean;
  /** Prefixes for the Turtle of the metadata. */
  prefixes?: Record<string, string>;
  /** Add a stored summary of every field when the source is ended. Default `true`. */
  summaries?: boolean;
}

/**
 * A growing source that rows can be appended to. Following the specification, a write
 * only adds rows: the time window and the description do not change while the source
 * grows, and the stored summaries and `tss:immutable true` are added when it is ended.
 */
export class WritableSource extends ReadableSource {
  private setup: WriterSetup = { fresh: false };
  private release?: () => Promise<void>;
  private closed = false;
  private lastInstant?: Instant;
  private total = 0;
  private readonly stats = new Map<string, FieldStats>();
  private pending: NormalizedRow[] = [];
  /** The column of a CSV file by position. */
  private csvColumns: (FieldMetadata | undefined)[] = [];

  /** @internal Use `Source.open` or `Source.create`. */
  static async start(
    store: Store,
    parsed: ParsedSource,
    origin: Origin,
    ctx: SourceContext,
    setup: WriterSetup,
    messages: Quad[][] = [],
  ): Promise<WritableSource> {
    const source = new WritableSource(store, parsed, origin, ctx, messages);
    source.setup = setup;
    try {
      await source.init();
    } catch (error) {
      await source.release?.();
      throw error;
    }
    return source;
  }

  private assertWritable(): void {
    const meta = this.metadata;
    if (meta.kind === 'Parquet' && !this.setup.fresh) throw new NotWritableError('a Parquet file is written once and cannot be appended to');
    if (this.endedSource()) throw new NotWritableError(`source ${this.id} is immutable (tss:immutable true)`);
  }

  /** A Parquet source is immutable by definition, but its writer still collects rows until it is closed. */
  private endedSource(): boolean {
    if (this.metadata.kind === 'Parquet' && this.setup.fresh) return this.closed;
    return this.metadata.immutable;
  }

  private async init(): Promise<void> {
    this.assertWritable();
    const { metadataFile, dataPath, fresh } = this.setup;
    const meta = this.metadata;
    if (meta.kind === 'EmbeddedRDF' && metadataFile && !fresh && this.messages.length === 0) {
      throw new NotWritableError('the metadata document of a growing embedded RDF source is an RDF Message Log: this document is not one');
    }
    const lockTarget = metadataFile ?? dataPath;
    if (lockTarget) this.release = await acquireLock(lockTarget, (message) => new LockError(message));

    for (const f of this.rowFields()) this.stats.set(f.id, new FieldStats(f));

    if (meta.kind !== 'EmbeddedRDF' && meta.kind !== 'EmbeddedJSON' && !dataPath) {
      throw new NotWritableError(`cannot write to ${this.dataFileIri()}: only local data files can be written`);
    }
    if (meta.stepField && meta.kind !== 'CSV') throw new NotWritableError('time grids can only be written to CSV sources');

    if (meta.kind === 'EmbeddedRDF' && this.messages.length === 0) this.messages = [[...this.store]];
    if (meta.kind === 'CSV') await this.initCsv(fresh);
    if (meta.kind === 'Arrow' && fresh) {
      // the schema message: the end-of-stream marker is only written when the source is ended
      const stream = await arrowStreamBytes(this.columnsFor([]));
      await writeFileAtomic(dataPath!, endsWithEos(stream) ? stream.subarray(0, stream.length - EOS_BYTES.length) : stream);
    }
    if (!fresh && meta.kind === 'Arrow') await this.checkArrowSchema();
    if (!fresh) await this.loadExisting();
  }

  /** The fields with a value in a row: all but the time field and the step field. */
  private rowFields(): FieldMetadata[] {
    const meta = this.metadata;
    return meta.fields.filter((f) => f.id !== meta.timeField && f.id !== meta.stepField);
  }

  private async initCsv(fresh: boolean): Promise<void> {
    const meta = this.metadata;
    const { dataPath } = this.setup;
    if (fresh) {
      const ordered = [...meta.fields].sort((a, b) => (a.columnIndex ?? 1e9) - (b.columnIndex ?? 1e9));
      const time = ordered.find((f) => f.id === meta.timeField);
      const columns = [time, ...ordered.filter((f) => f !== time)].filter((f): f is FieldMetadata => !!f && (f.columnName !== undefined || f.columnIndex !== undefined));
      if (meta.header) {
        this.csvColumns = columns;
        await writeFileAtomic(dataPath!, csvLine(columns.map((f) => f.columnName ?? f.localName), meta.delimiter));
      } else {
        this.csvColumns = [];
        columns.forEach((f, index) => (this.csvColumns[f.columnIndex ?? index] = f));
        await writeFileAtomic(dataPath!, '');
      }
      return;
    }
    if (meta.header) {
      let header: string[] | undefined;
      for await (const row of parseCsv(decodeChunks(localChunks(dataPath!), meta.encoding), meta.delimiter)) {
        header = row.cells;
        break;
      }
      if (!header) throw new ValidationError('the CSV file has no header line');
      this.csvColumns = header.map((name) => meta.fields.find((f) => f.columnName === name));
      for (const f of meta.fields) {
        if (f.columnName !== undefined && !header.includes(f.columnName)) {
          throw new ValidationError(`the CSV file has no column ${JSON.stringify(f.columnName)} for field ${f.id}`);
        }
      }
    } else {
      for (const f of meta.fields) if (f.columnIndex !== undefined) this.csvColumns[f.columnIndex] = f;
    }
  }

  private async checkArrowSchema(): Promise<void> {
    const ours = await arrowStreamBytes(this.columnsFor([]));
    const view = new DataView(ours.buffer, ours.byteOffset, ours.byteLength);
    const schemaLength = 8 + view.getInt32(4, true);
    const head = await readHead(this.setup.dataPath!, schemaLength);
    const same = head.length === schemaLength && ours.subarray(0, schemaLength).every((byte, i) => byte === head[i]);
    if (!same) {
      throw new NotWritableError('can only append to an Arrow stream with the schema this library writes for these fields; the file has another schema or is in the IPC file format');
    }
  }

  private columnsFor(rows: NormalizedRow[]) {
    const meta = this.metadata;
    const timeField = meta.fields.find((f) => f.id === meta.timeField)!;
    const encoded = rows.map((r) => ({ time: r.time, values: this.encodeValues(r.values) }));
    return tableColumns(timeField, this.rowFields(), encoded);
  }

  private encodeValues(values: Map<string, string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const [id, text] of values) {
      const f = this.metadata.fields.find((x) => x.id === id)!;
      if (f.valueEncoding === DELTA) {
        const baseline = f.baseline !== undefined ? Decimal.parse(f.baseline) : null;
        const value = Decimal.parse(text);
        if (!baseline || !value) throw new ValidationError(`cannot encode ${JSON.stringify(text)} of field ${id} against baseline ${f.baseline}`);
        out.set(id, value.add(new Decimal(-baseline.int, baseline.scale)).toString());
      } else {
        out.set(id, text);
      }
    }
    return out;
  }

  /** Read the rows that are already there: for the latest time and the stored summaries. */
  private async loadExisting(): Promise<void> {
    const meta = this.metadata;
    const from = meta.from ? toInstant(meta.from) : undefined;
    const until = meta.until ? toInstant(meta.until) : undefined;
    for await (const raw of this.rows()) {
      const instant = instantOf(raw.time);
      if (this.lastInstant === undefined || instant > this.lastInstant) this.lastInstant = instant;
      if ((from !== undefined && instant < from) || (until !== undefined && instant >= until)) continue;
      this.total++;
      for (const [id, text] of raw.values) this.stats.get(id)?.add(instant, this.decodeForStats(id, text));
    }
  }

  private decodeForStats(id: string, text: string): string {
    const f = this.metadata.fields.find((x) => x.id === id)!;
    if (f.valueEncoding !== DELTA) return text;
    const baseline = f.baseline !== undefined ? Decimal.parse(f.baseline) : null;
    const value = Decimal.parse(text);
    return baseline && value ? baseline.add(value).toString() : text;
  }

  private normalize(input: RowInput, index: number): NormalizedRow {
    const problems: ReportEntry[] = [];
    const where = `row ${index + 1}`;
    let time: string;
    if (input.time instanceof Date) {
      if (Number.isNaN(input.time.getTime())) throw new ValidationError(`${where} has an invalid Date as time`);
      time = formatInstant(toInstant(input.time));
    } else {
      time = input.time;
      if (parseTime(time) === null) problems.push({ rule: 'time', message: `${where}: ${JSON.stringify(time)} is not an xsd:dateTimeStamp (it needs a timezone)` });
    }
    const values = new Map<string, string>();
    for (const [key, raw] of Object.entries(input.values ?? {})) {
      let field: FieldMetadata;
      try {
        field = this.resolveField(key);
      } catch (error) {
        problems.push({ rule: 'unknown-field', message: `${where}: ${(error as Error).message}` });
        continue;
      }
      if (field.id === this.metadata.timeField || field.id === this.metadata.stepField) {
        problems.push({ rule: 'time-value', message: `${where}: ${key} is the time field; give the time as time` });
        continue;
      }
      if (raw === null || raw === undefined || raw === '') continue;
      const text = typeof raw === 'number' ? numberToLexical(raw) : String(raw);
      if (!isValidLexical(field.datatype, text)) {
        problems.push({ rule: 'lexical-form', node: field.id, message: `${where}: ${JSON.stringify(text)} is not a valid ${field.datatype}` });
        continue;
      }
      values.set(field.id, text);
    }
    if (this.metadata.kind === 'EmbeddedRDF') {
      // a point states the time, its reading and the values of the describing fields of its field
      for (const id of values.keys()) {
        const f = this.metadata.fields.find((x) => x.id === id)!;
        if (f.kind !== 'meta') continue;
        if (f.describesField.length === 0) {
          problems.push({ rule: 'not-stated', node: f.id, message: `${where}: the points of an embedded RDF source cannot state the values of ${f.localName}, a meta field that describes no value field` });
        } else if (!f.describesField.some((target) => values.has(target))) {
          problems.push({ rule: 'not-stated', node: f.id, message: `${where}: ${f.localName} describes a value field that has no value in this row, so there is no point to state it on` });
        }
      }
    }
    if (problems.length) throw new ValidationError(problems[0].message, makeReport(problems));
    return { time, instant: instantOf(time), values };
  }

  /** The step of a time (on a fixed time grid). */
  private stepOf(instant: Instant): bigint {
    const meta = this.metadata;
    const base = parseTime(meta.timeBase!)!;
    const step = parseDuration(meta.timeStep!)!;
    const baseInstant = instantOf(meta.timeBase!);
    const stepNs = (BigInt(step.days) * 86_400n * NS_PER_SECOND + step.clockNs) * (step.negative ? -1n : 1n);
    if (step.years || step.months || stepNs <= 0n) throw new NotWritableError('only a time grid with a fixed positive step can be written');
    const delta = instant - baseInstant;
    const n = delta / stepNs;
    if (delta < 0n || delta % stepNs !== 0n || instantOf(formatTime(gridTime(base, step, n))) !== instant) {
      throw new ValidationError(`${formatInstant(instant)} is not on the time grid of ${this.id}`);
    }
    return n;
  }

  /**
   * Add one or more rows: all of them, or none. Checks the datatypes, the unique and
   * increasing times and the time window, which is fixed while the source grows, and adds the
   * rows at the end of the data. The description of the source does not change.
   */
  async append(input: RowInput | RowInput[]): Promise<void> {
    if (this.closed) throw new NotWritableError('the source is closed');
    if (this.endedSource()) throw new NotWritableError(`source ${this.id} is immutable (tss:immutable true)`);
    const readings = Array.isArray(input) ? input : [input];
    if (readings.length === 0) return;
    const rows = readings.map((r, i) => this.normalize(r, i));

    const meta = this.metadata;
    const from = meta.from ? toInstant(meta.from) : undefined;
    const until = meta.until ? toInstant(meta.until) : undefined;
    const problems: ReportEntry[] = [];
    let previous = this.lastInstant;
    rows.forEach((row, i) => {
      if (previous !== undefined && row.instant <= previous) {
        problems.push({
          rule: previous === row.instant ? 'unique-time' : 'time-order',
          message: `row ${i + 1} (${row.time}) is not after the previous row (${formatInstant(previous)}): times are unique and increase`,
        });
      }
      if ((from !== undefined && row.instant < from) || (until !== undefined && row.instant >= until)) {
        problems.push({
          rule: 'window',
          message: `row ${i + 1} (${row.time}) lies outside the time window of the source [${meta.from ?? ''}, ${meta.until ?? ''}): the window of a growing source is fixed, so start a new source`,
        });
      }
      previous = row.instant;
    });
    if (problems.length) throw new ValidationError(problems[0].message, makeReport(problems));

    await this.writeRows(rows);

    for (const row of rows) {
      this.total++;
      for (const [id, text] of row.values) this.stats.get(id)?.add(row.instant, text);
    }
    this.lastInstant = rows[rows.length - 1].instant;
    // the description does not change, but the metadata document of an embedded JSON source holds the rows
    if (meta.kind === 'EmbeddedJSON') await this.persist();
  }

  private async writeRows(rows: NormalizedRow[]): Promise<void> {
    const meta = this.metadata;
    const { dataPath } = this.setup;
    switch (meta.kind) {
      case 'EmbeddedRDF':
        await this.appendMessages(rows);
        return;
      case 'EmbeddedJSON':
        this.addJsonPoints(rows);
        return;
      case 'CSV': {
        const lines = rows.map((row) => {
          const encoded = this.encodeValues(row.values);
          const step = meta.stepField ? this.stepOf(row.instant) : undefined;
          return csvLine(
            this.csvColumns.map((f) => {
              if (!f) return undefined;
              if (f.id === meta.timeField) return row.time;
              if (f.id === meta.stepField) return String(step);
              return encoded.get(f.id);
            }),
            meta.delimiter,
          );
        });
        await appendLocal(dataPath!, lines.join(''));
        return;
      }
      case 'Arrow': {
        // complete record batches only, and no end-of-stream marker while the source grows
        const stream = await arrowStreamBytes(this.columnsFor(rows));
        await appendLocal(dataPath!, recordBatchMessages(stream));
        return;
      }
      case 'Parquet':
        this.pending.push(...rows);
        return;
    }
  }

  /**
   * One message for each row, appended to the RDF Message Log: the source links with
   * `tss:hasPoint` to one point for each value field with a value, which states the time, the
   * value, and the values of the describing fields that describe its field.
   */
  private async appendMessages(rows: NormalizedRow[]): Promise<void> {
    const { time, fields } = pointFields(this.parsed);
    const source = this.parsed.term;
    const valueFields = fields.filter((f) => f.kind === 'value');
    const describers = (id: string) => fields.filter((f) => f.kind === 'meta' && f.describesField.includes(id));
    const added: Quad[][] = [];
    for (const row of rows) {
      const quads: Quad[] = [];
      for (const f of valueFields) {
        const text = row.values.get(f.id);
        if (text === undefined) continue;
        const point = blankNode();
        quads.push(
          quad(source as NamedNode, namedNode(tss('hasPoint')), point),
          quad(point, namedNode(time.property), literal(row.time, namedNode(xsd('dateTimeStamp')))),
          quad(point, namedNode(f.property), this.literalOf(f, text)),
        );
        for (const d of describers(f.id)) {
          const described = row.values.get(d.id);
          if (described !== undefined) quads.push(quad(point, namedNode(d.property), this.literalOf(d, described)));
        }
      }
      added.push(quads);
    }
    const { metadataFile } = this.setup;
    if (metadataFile) await appendLocal(metadataFile, await serializeMessagesTail(added.map((m) => this.relative(m)), this.prefixes()));
    for (const quads of added) {
      this.store.addQuads(quads);
      this.messages.push(quads);
    }
  }

  private literalOf(f: FieldMetadata, text: string) {
    return f.language ? literal(text, f.language) : literal(text, namedNode(f.datatype));
  }

  /**
   * The quads with the default field properties of an embedded source as relative IRIs
   * (`<#columnName>`): they are made from the IRI of the metadata document, so they stay right
   * wherever the document is published.
   */
  private relative(quads: Iterable<Quad>): Quad[] {
    const base = this.baseIRI?.replace(/#.*$/, '');
    const own = new Set(this.metadata.fields.filter((f) => f.defaultProperty && f.property && f.id !== this.metadata.timeField).map((f) => f.property!));
    const list = [...quads];
    if (!base || own.size === 0 || (this.metadata.kind !== 'EmbeddedRDF' && this.metadata.kind !== 'EmbeddedJSON')) return list;
    const map = <T extends Quad['predicate'] | Quad['object']>(term: T): T =>
      (term.termType === 'NamedNode' && own.has(term.value) && term.value.startsWith(base + '#') ? namedNode(term.value.slice(base.length)) : term) as T;
    return list.map((q) => quad(q.subject, map(q.predicate), map(q.object), q.graph));
  }

  private addJsonPoints(rows: NormalizedRow[]): void {
    const meta = this.metadata;
    const source = this.parsed.term;
    const existing = objectOf(this.store, source, tss('points'));
    const points: Record<string, string>[] = existing ? JSON.parse(existing.value) : [];
    const timeField = meta.fields.find((f) => f.id === meta.timeField)!;
    for (const row of rows) {
      const object: Record<string, string> = { [timeField.columnName!]: row.time };
      for (const [id, text] of row.values) object[meta.fields.find((x) => x.id === id)!.columnName!] = text;
      points.push(object);
    }
    this.setObject(source, tss('points'), literal(JSON.stringify(points), namedNode(RDF + 'JSON')));
  }

  private setObject(subject: Term, predicate: string, object: Term | undefined): void {
    for (const q of [...this.store.match(subject as never, namedNode(predicate), null, null)]) this.store.removeQuad(q);
    if (object) this.store.addQuad(quad(subject as never, namedNode(predicate), object as never));
  }

  /** The statements that end the source: `tss:immutable true` and the stored summaries. */
  private endingQuads(): Quad[] {
    const source = this.parsed.term;
    const out: Quad[] = [quad(source as never, namedNode(tss('immutable')), literal('true', namedNode(xsd('boolean'))))];
    if (this.setup.summaries === false) return out;
    const now = BigInt(Date.now()) * 1_000_000n;
    const stamp = (text: string) => literal(text, namedNode(xsd('dateTimeStamp')));
    const integer = (n: number) => literal(String(n), namedNode(xsd('integer')));
    for (const [id, stats] of this.stats) {
      const field = this.parsed.fieldTerms.get(id)!;
      const node = blankNode();
      const s = stats.summary(this.total, now);
      const add = (predicate: string, object: Term) => out.push(quad(node, namedNode(predicate), object as never));
      out.push(quad(field as never, namedNode(tss('summary')), node));
      add(tss('missingValuePolicy'), namedNode(s.missingValuePolicy!));
      add(tss('count'), integer(s.count!));
      add(tss('missing'), integer(s.missing!));
      if (s.firstTime) add(tss('firstTime'), stamp(s.firstTime));
      if (s.lastTime) add(tss('lastTime'), stamp(s.lastTime));
      if (s.observedMinimum !== undefined) add(tss('observedMinimum'), literal(s.observedMinimum, namedNode(stats.field.datatype)));
      if (s.observedMaximum !== undefined) add(tss('observedMaximum'), literal(s.observedMaximum, namedNode(stats.field.datatype)));
      if (s.mean !== undefined) add(tss('mean'), literal(s.mean, namedNode(xsd('double'))));
      if (s.median !== undefined) add(tss('median'), literal(s.median, namedNode(xsd('double'))));
      add(tss('generatedAtTime'), stamp(s.generatedAtTime!));
    }
    return out;
  }

  private prefixes(): Record<string, string> {
    const prefixes: Record<string, string> = {
      tss: 'https://w3id.org/tss#',
      rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
    };
    const iri = this.id;
    const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
    if (cut > 0 && !iri.startsWith('_:')) prefixes.ex = iri.slice(0, cut + 1);
    return { ...prefixes, ...this.setup.prefixes };
  }

  /**
   * The metadata (and the embedded rows) as Turtle, TriG, N-Triples, N-Quads or JSON-LD. A
   * growing embedded RDF source is an RDF Message Log in Turtle: one message for the
   * description, and one for each row.
   */
  async serialize(mediaType = 'text/turtle', prefixes: Record<string, string> = {}): Promise<string> {
    const all = { ...this.prefixes(), ...prefixes };
    if (this.metadata.kind === 'EmbeddedRDF' && mediaType.split(';')[0].trim() === 'text/turtle' && this.messages.length > 0) {
      return serializeMessages(this.messages.map((m) => this.relative(m)), all);
    }
    // only Turtle and TriG can write the IRIs relative to the document
    const turtle = /^(text\/turtle|application\/x-turtle|application\/trig)$/.test(mediaType.split(';')[0].trim());
    return serializeRdf(turtle ? this.relative(this.store) : this.store, mediaType, all);
  }

  private async persist(): Promise<void> {
    const file = this.setup.metadataFile;
    if (!file) return;
    await writeFileAtomic(file, await this.serialize('text/turtle'));
  }

  /** The metadata file, written for the first time. Used by `Source.create`. */
  async persistNow(): Promise<void> {
    await this.persist();
  }

  /**
   * Release the lock. With `freeze`, the source is ended first: its last rows are written,
   * and `tss:immutable true` and the stored summaries are added, so that followers stop. A
   * Parquet source is written here, and is always ended.
   */
  async close(options: { freeze?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    try {
      const isParquet = this.metadata.kind === 'Parquet';
      if (isParquet) await writeFileAtomic(this.setup.dataPath!, await parquetBytes(this.columnsFor(this.pending)));
      if (options.freeze || isParquet) {
        // Arrow: the end-of-stream marker may follow the last batch
        if (this.metadata.kind === 'Arrow') await appendLocal(this.setup.dataPath!, EOS_BYTES);
        const ending = this.endingQuads();
        if (this.metadata.kind === 'EmbeddedRDF') {
          const { metadataFile } = this.setup;
          if (metadataFile) await appendLocal(metadataFile, await serializeMessagesTail([this.relative(ending)], this.prefixes()));
          this.messages.push(ending);
          this.store.addQuads(ending);
        } else {
          this.setObject(this.parsed.term, tss('immutable'), undefined);
          this.store.addQuads(ending);
          await this.persist();
        }
        this.replace(this.store);
      }
    } finally {
      this.closed = true;
      await this.release?.();
      this.release = undefined;
    }
  }
}
