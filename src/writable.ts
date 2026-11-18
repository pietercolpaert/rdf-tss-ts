import type { Store } from 'n3';
import { Decimal } from './decimal.js';
import { LockError, NotWritableError, ValidationError, makeReport, type ReportEntry } from './errors.js';
import { isValidLexical, numberToLexical } from './lexical.js';
import { RDF, tss, xsd } from './ns.js';
import {
  acquireLock,
  appendLocal,
  localChunks,
  localSize,
  readHead,
  readTail,
  truncateAndAppend,
  writeFileAtomic,
} from './platform.js';
import { blankNode, literal, namedNode, objectOf, quad, rdfFormatFor, serializeRdf } from './rdf.js';
import type { Term } from './rdf.js';
import { ReadableSnippet, type Origin, type SnippetContext } from './readable.js';
import type { ParsedSnippet } from './metadata.js';
import { csvLine } from './writers/csv.js';
import { FieldStats } from './writers/summary.js';
import {
  EOS_BYTES,
  arrowStreamBytes,
  endsWithEos,
  parquetBytes,
  recordBatchMessages,
  tableColumns,
  type RowToWrite,
} from './writers/tables.js';
import { parseCsv } from './sources/csv.js';
import { decodeChunks } from './sources/access.js';
import { formatInstant, gridTime, instantOf, parseDuration, parseTime, toInstant, formatTime, type Instant } from './time.js';
import type { FieldMetadata, ReadingInput } from './types.js';

const DELTA = tss('DeltaFromBaseline');
const NS_PER_SECOND = 1_000_000_000n;

interface NormalizedRow {
  time: string;
  instant: Instant;
  /** Values as the user gave them. */
  values: Map<string, string>;
}

export interface WriterSetup {
  /** The metadata file that is rewritten after every `append`. */
  metadataFile?: string;
  /** The local file with the points of an external snippet. */
  dataPath?: string;
  /** A new snippet: its data file does not exist yet. */
  fresh: boolean;
  /** Prefixes for the Turtle of the metadata. */
  prefixes?: Record<string, string>;
}

const MEDIA_TYPE: Record<string, string> = {
  turtle: 'text/turtle',
  trig: 'application/trig',
  'n-triples': 'application/n-triples',
  'n-quads': 'application/n-quads',
  jsonld: 'application/ld+json',
};

/** A snippet that can also be appended to. */
export class WritableSnippet extends ReadableSnippet {
  private setup: WriterSetup = { fresh: false };
  private release?: () => Promise<void>;
  private closed = false;
  private lastInstant?: Instant;
  private total = 0;
  private readonly stats = new Map<string, FieldStats>();
  private pending: NormalizedRow[] = [];
  /** The column of a CSV file by position. */
  private csvColumns: (FieldMetadata | undefined)[] = [];

  /** @internal Use `Snippet.open` or `Snippet.create`. */
  static async start(
    store: Store,
    parsed: ParsedSnippet,
    origin: Origin,
    ctx: SnippetContext,
    setup: WriterSetup,
  ): Promise<WritableSnippet> {
    const snippet = new WritableSnippet(store, parsed, origin, ctx);
    snippet.setup = setup;
    try {
      await snippet.init();
    } catch (error) {
      await snippet.release?.();
      throw error;
    }
    return snippet;
  }

  private assertWritable(): void {
    const meta = this.metadata;
    if (meta.kind === 'Parquet' && !this.setup.fresh) throw new NotWritableError('a Parquet file is written once and cannot be appended to');
    if (!meta.mutable) throw new NotWritableError(`snippet ${this.id} is immutable (tss:mutable false)`);
  }

  private async init(): Promise<void> {
    this.assertWritable();
    const { metadataFile, dataPath, fresh } = this.setup;
    const lockTarget = metadataFile ?? dataPath;
    if (lockTarget) this.release = await acquireLock(lockTarget, (message) => new LockError(message));

    const meta = this.metadata;
    const valueFields = this.valueFields();
    for (const f of valueFields) if (f.summary) this.stats.set(f.id, new FieldStats(f));

    if (meta.kind !== 'EmbeddedRDF' && meta.kind !== 'EmbeddedJSON' && !dataPath) {
      throw new NotWritableError(`cannot write to ${this.dataFileIri()}: only local data files can be written`);
    }
    if (meta.stepField && meta.kind !== 'CSV') throw new NotWritableError('time grids can only be written to CSV snippets');

    if (meta.kind === 'CSV') await this.initCsv(fresh);
    if (meta.kind === 'Arrow' && fresh) await writeFileAtomic(dataPath!, await arrowStreamBytes(this.columnsFor([])));
    if (!fresh && meta.kind === 'Arrow') await this.checkArrowSchema();
    if (!fresh) await this.loadExisting();
  }

  private valueFields(): FieldMetadata[] {
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
    const rows = this.columnsFor([]);
    const ours = await arrowStreamBytes(rows);
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
    const encoded: RowToWrite[] = rows.map((r) => ({ time: r.time, values: this.encodeValues(r.values) }));
    return tableColumns(timeField, this.valueFields(), encoded);
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

  /** Read the points that are already there: for the latest time and the stored summaries. */
  private async loadExisting(): Promise<void> {
    const meta = this.metadata;
    const from = meta.from ? toInstant(meta.from) : undefined;
    const until = meta.until ? toInstant(meta.until) : undefined;
    for await (const raw of this.points({ skip: 0, strict: false })) {
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

  private normalize(input: ReadingInput, index: number): NormalizedRow {
    const problems: ReportEntry[] = [];
    const where = `reading ${index + 1}`;
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
   * Add one or more readings: all of them, or none. Checks the datatypes, the unique and
   * increasing times, adds the points, widens the time window, and recomputes the summaries.
   */
  async append(input: ReadingInput | ReadingInput[]): Promise<void> {
    if (this.closed) throw new NotWritableError('the snippet is closed');
    if (!this.metadata.mutable) throw new NotWritableError(`snippet ${this.id} is immutable (tss:mutable false)`);
    const readings = Array.isArray(input) ? input : [input];
    if (readings.length === 0) return;
    const rows = readings.map((r, i) => this.normalize(r, i));

    const problems: ReportEntry[] = [];
    let previous = this.lastInstant;
    rows.forEach((row, i) => {
      if (previous !== undefined && row.instant <= previous) {
        problems.push({
          rule: previous === row.instant ? 'unique-time' : 'time-order',
          message: `reading ${i + 1} (${row.time}) is not after the previous point (${formatInstant(previous)}): times are unique and increase`,
        });
      }
      previous = row.instant;
    });
    if (problems.length) throw new ValidationError(problems[0].message, makeReport(problems));

    const meta = this.metadata;
    const now = BigInt(Date.now()) * 1_000_000n;
    const earliest = rows[0].instant;
    const newest = rows[rows.length - 1].instant;
    let from = meta.from;
    let until = meta.until;
    if (from && earliest < toInstant(from)) from = formatInstant(earliest);
    if (until && newest >= toInstant(until)) until = formatInstant(newest + NS_PER_SECOND);

    await this.writeRows(rows);

    for (const row of rows) {
      this.total++;
      for (const [id, text] of row.values) this.stats.get(id)?.add(row.instant, text);
    }
    this.lastInstant = newest;
    this.updateMetadata({ from, until, now });
    await this.persist();
  }

  private async writeRows(rows: NormalizedRow[]): Promise<void> {
    const meta = this.metadata;
    const { dataPath } = this.setup;
    switch (meta.kind) {
      case 'EmbeddedRDF':
        this.addRdfPoints(rows);
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
        const stream = await arrowStreamBytes(this.columnsFor(rows));
        const batches = recordBatchMessages(stream);
        const out = new Uint8Array(batches.length + EOS_BYTES.length);
        out.set(batches, 0);
        out.set(EOS_BYTES, batches.length);
        const size = await localSize(dataPath!);
        await truncateAndAppend(dataPath!, endsWithEos(await readTail(dataPath!, 8)) ? size - 8 : size, out);
        return;
      }
      case 'Parquet':
        this.pending.push(...rows);
        return;
    }
  }

  private addRdfPoints(rows: NormalizedRow[]): void {
    const meta = this.metadata;
    const snippet = this.parsed.term;
    const timeTerm = this.parsed.fieldTerms.get(meta.timeField)!;
    for (const row of rows) {
      const point = blankNode();
      this.store.addQuad(quad(snippet as never, namedNode(tss('hasPoint')), point));
      this.store.addQuad(quad(point, namedNode(timeTerm.value), literal(row.time, namedNode(xsd('dateTimeStamp')))));
      for (const [id, text] of row.values) {
        const f = meta.fields.find((x) => x.id === id)!;
        const term = this.parsed.fieldTerms.get(id)!;
        const value = f.language ? literal(text, f.language) : literal(text, namedNode(f.datatype));
        this.store.addQuad(quad(point, namedNode(term.value), value));
      }
    }
  }

  private addJsonPoints(rows: NormalizedRow[]): void {
    const meta = this.metadata;
    const snippet = this.parsed.term;
    const existing = objectOf(this.store, snippet, tss('points'));
    const points: Record<string, string>[] = existing ? JSON.parse(existing.value) : [];
    const timeField = meta.fields.find((f) => f.id === meta.timeField)!;
    for (const row of rows) {
      const object: Record<string, string> = { [timeField.columnName!]: row.time };
      for (const [id, text] of row.values) object[meta.fields.find((x) => x.id === id)!.columnName!] = text;
      points.push(object);
    }
    this.setObject(snippet, tss('points'), literal(JSON.stringify(points), namedNode(RDF + 'JSON')));
  }

  private setObject(subject: Term, predicate: string, object: Term | undefined): void {
    for (const q of [...this.store.match(subject as never, namedNode(predicate), null, null)]) this.store.removeQuad(q);
    if (object) this.store.addQuad(quad(subject as never, namedNode(predicate), object as never));
  }

  private removeNode(node: Term): void {
    for (const q of [...this.store.match(node as never, null, null, null)]) {
      this.store.removeQuad(q);
      if (q.object.termType === 'BlankNode') this.removeNode(q.object);
    }
  }

  /** Window, `committedUntil` and summaries after a write. */
  private updateMetadata(change: { from?: string; until?: string; now: Instant; mutable?: boolean }): void {
    const snippet = this.parsed.term;
    const stamp = (text: string) => literal(text, namedNode(xsd('dateTimeStamp')));
    if (change.from !== undefined) this.setObject(snippet, tss('from'), stamp(change.from));
    if (change.until !== undefined) this.setObject(snippet, tss('until'), stamp(change.until));
    this.setObject(snippet, tss('committedUntil'), stamp(formatInstant(change.now)));
    if (change.mutable !== undefined) this.setObject(snippet, tss('mutable'), literal(String(change.mutable), namedNode(xsd('boolean'))));

    for (const [id, stats] of this.stats) {
      const fieldTerm = this.parsed.fieldTerms.get(id)!;
      const old = objectOf(this.store, fieldTerm, tss('summary'));
      if (old) this.removeNode(old);
      this.setObject(fieldTerm, tss('summary'), undefined);
      const node = blankNode();
      const s = stats.summary(this.total, change.now);
      const add = (predicate: string, object: Term) => this.store.addQuad(quad(node, namedNode(predicate), object as never));
      const integer = (n: number) => literal(String(n), namedNode(xsd('integer')));
      this.store.addQuad(quad(fieldTerm as never, namedNode(tss('summary')), node));
      add(tss('missingValuePolicy'), namedNode(s.missingValuePolicy!));
      add(tss('count'), integer(s.count!));
      add(tss('missing'), integer(s.missing!));
      if (s.firstTime) add(tss('firstTime'), stamp(s.firstTime));
      if (s.lastTime) add(tss('lastTime'), stamp(s.lastTime));
      const field = stats.field;
      if (s.observedMinimum !== undefined) add(tss('observedMinimum'), literal(s.observedMinimum, namedNode(field.datatype)));
      if (s.observedMaximum !== undefined) add(tss('observedMaximum'), literal(s.observedMaximum, namedNode(field.datatype)));
      if (s.mean !== undefined) add(tss('mean'), literal(s.mean, namedNode(xsd('double'))));
      if (s.median !== undefined) add(tss('median'), literal(s.median, namedNode(xsd('double'))));
      add(tss('generatedAtTime'), stamp(s.generatedAtTime!));
    }
    this.replace(this.store);
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

  /** The metadata (and the embedded points) as Turtle, TriG, N-Triples, N-Quads or JSON-LD. */
  async serialize(mediaType = 'text/turtle'): Promise<string> {
    return serializeRdf(this.store, mediaType, this.prefixes());
  }

  private async persist(): Promise<void> {
    const file = this.setup.metadataFile;
    if (!file) return;
    const mediaType = MEDIA_TYPE[rdfFormatFor({ filename: file })];
    await writeFileAtomic(file, await this.serialize(mediaType));
  }

  /** The metadata file written so far, if any. Used by `Snippet.create` for the first write. */
  async persistNow(): Promise<void> {
    await this.persist();
  }

  /**
   * Write outstanding data and release the lock. `freeze` sets `tss:mutable false`, so that
   * followers stop. A Parquet snippet is written here, and is always frozen.
   */
  async close(options: { freeze?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    try {
      const isParquet = this.metadata.kind === 'Parquet';
      if (isParquet) await writeFileAtomic(this.setup.dataPath!, await parquetBytes(this.columnsFor(this.pending)));
      if (options.freeze || isParquet) {
        this.updateMetadata({ now: BigInt(Date.now()) * 1_000_000n, mutable: false });
      }
      await this.persist();
    } finally {
      this.closed = true;
      await this.release?.();
      this.release = undefined;
    }
  }
}

