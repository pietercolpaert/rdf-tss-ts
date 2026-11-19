/**
 * Following a growing source (spec: "Following a growing source"): the metadata document of a
 * growing `tss:EmbeddedRDFSource` (an RDF Message Log), and the data file of a growing CSV or
 * Arrow source only grow. A follower reads them once, keeps the offset after the last complete
 * unit, and asks for the bytes after it with a Range request.
 */
import { iriToPath, readFromOffset } from './platform.js';
import type { DataContext } from './formats/access.js';
import { parseCsvText, type CsvColumns } from './formats/csv.js';
import type { RawRow } from './formats/rows.js';
import { arrowRows } from './formats/table.js';
import type { SourceMetadata } from './types.js';
import type { Quad } from './rdf.js';
import { parseLogMessages } from './rdf.js';

export interface PollResult {
  rows: RawRow[];
  /** The source is immutable now, and everything has been read. */
  ended: boolean;
  /** Quads that are new in the metadata (an RDF Message Log), to add to the description. */
  quads?: Quad[];
  /** The whole document was read again: its quads replace the description. */
  replaced?: boolean;
}

export interface Follower {
  /** How long the server says a representation stays fresh (`Cache-Control: max-age`), in milliseconds. */
  maxAgeMs?: number;
  /** Read what was added since the last call. */
  poll(signal?: AbortSignal): Promise<PollResult>;
}

type Read = { bytes: Uint8Array; whole: boolean } | { gone: true } | null;

const maxAgeOf = (control: string | null): number | undefined => {
  const m = control && /max-age=(\d+)/i.exec(control);
  return m ? Number(m[1]) * 1000 : undefined;
};

/** Reads a growing resource in steps: all of it, then the bytes after the offset. */
export class ByteSource {
  /** The number of bytes up to the end of the last complete unit. */
  offset = 0;
  maxAgeMs?: number;

  constructor(
    private readonly iri: string,
    private readonly ctx: DataContext,
  ) {}

  /** Start again from the first byte. */
  reset(): void {
    this.offset = 0;
  }

  async read(signal?: AbortSignal): Promise<Read> {
    if (/^file:/i.test(this.iri)) {
      if (!this.ctx.allowLocal) throw new Error(`${this.iri} is a local file; pass { localFiles: true } to allow reading local files`);
      const path = await iriToPath(this.iri);
      const result = await readFromOffset(path, this.offset);
      if (result.status === 'same') return null;
      if (result.status === 'shrunk') {
        this.offset = 0;
        const whole = await readFromOffset(path, 0);
        return whole.status === 'bytes' ? { bytes: whole.bytes, whole: true } : null;
      }
      return { bytes: result.bytes, whole: this.offset === 0 };
    }
    if (!/^https?:/i.test(this.iri)) throw new Error(`cannot read ${JSON.stringify(this.iri)}: it is not an absolute http(s) or file IRI`);

    const ranged = this.offset > 0;
    const headers: Record<string, string> = {};
    if (ranged) {
      // no If-Range: every append changes the validators, so it would return everything again
      headers.Range = `bytes=${this.offset}-`;
      headers['Accept-Encoding'] = 'identity';
    }
    const response = await this.ctx.fetch(this.iri, { headers, signal });
    this.maxAgeMs = maxAgeOf(response.headers.get('cache-control')) ?? this.maxAgeMs;
    if (response.status === 404 || response.status === 410) return { gone: true };
    if (response.status === 416) {
      const length = Number(/\*\/(\d+)/.exec(response.headers.get('content-range') ?? '')?.[1] ?? NaN);
      if (length === this.offset) return null;
      this.offset = 0;
      return this.read(signal);
    }
    if (response.status === 206) {
      const start = Number(/bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1] ?? NaN);
      if (start !== this.offset) {
        this.offset = 0;
        return this.read(signal);
      }
      return { bytes: new Uint8Array(await response.arrayBuffer()), whole: false };
    }
    if (!response.ok) throw new Error(`could not fetch ${this.iri}: HTTP ${response.status}`);
    // 200: the server ignored the Range header, or this is the first request
    return { bytes: new Uint8Array(await response.arrayBuffer()), whole: true };
  }
}

/** Rows whose time was not emitted yet: the key identifies a row, also after a fallback to a full read. */
export class Seen {
  private readonly times = new Set<string>();
  fresh(rows: RawRow[]): RawRow[] {
    const out: RawRow[] = [];
    for (const p of rows) {
      if (this.times.has(p.time)) continue;
      this.times.add(p.time);
      out.push(p);
    }
    return out;
  }
}

/* ---------- CSV ---------- */

export class CsvFollower implements Follower {
  private columns?: CsvColumns;
  private readonly seen = new Seen();
  private readonly utf8: boolean;

  constructor(
    private readonly meta: SourceMetadata,
    private readonly source: ByteSource,
  ) {
    this.utf8 = /^utf-?8$/i.test(meta.encoding);
  }

  get maxAgeMs(): number | undefined {
    return this.source.maxAgeMs;
  }

  async poll(signal?: AbortSignal): Promise<PollResult> {
    const result = await this.source.read(signal);
    if (!result || 'gone' in result) return { rows: [], ended: 'gone' in (result ?? {}) };
    if (result.whole) this.columns = undefined;
    const text = new TextDecoder(this.meta.encoding).decode(result.bytes);
    const parsed = await parseCsvText(this.meta, text, this.columns);
    this.columns = parsed.columns;
    // another encoding than UTF-8: the offset in bytes of a character is not known, so read everything again
    this.source.offset = this.utf8 ? (result.whole ? 0 : this.source.offset) + new TextEncoder().encode(text.slice(0, parsed.consumed)).length : 0;
    return { rows: this.seen.fresh(parsed.rows), ended: false };
  }
}

/* ---------- Arrow ---------- */

const CONTINUATION = 0xffffffff;
/** `MessageHeader` of Arrow's Message.fbs */
const SCHEMA = 1;
const DICTIONARY_BATCH = 2;
const RECORD_BATCH = 3;

interface WalkedMessages {
  /** The end of the last complete message. */
  end: number;
  /** The end of the schema message and of the dictionary messages before the first record batch. */
  prefixEnd: number;
  types: number[];
  /** The end-of-stream marker follows the last message. */
  eos: boolean;
}

/** Walk the encapsulated messages of an Arrow IPC stream: where the last complete one ends. */
export function walkArrowMessages(bytes: Uint8Array): WalkedMessages {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: WalkedMessages = { end: 0, prefixEnd: 0, types: [], eos: false };
  let position = 0;
  let sawBatch = false;
  while (position + 8 <= bytes.length) {
    if (view.getUint32(position, true) !== CONTINUATION) break;
    const metadataLength = view.getInt32(position + 4, true);
    if (metadataLength === 0) {
      out.eos = true;
      out.end = position + 8;
      break;
    }
    if (position + 8 + metadataLength > bytes.length) break;
    const table = position + 8 + view.getUint32(position + 8, true);
    const vtable = table - view.getInt32(table, true);
    const vtableLength = view.getUint16(vtable, true);
    const field = (index: number) => (4 + 2 * index < vtableLength ? view.getUint16(vtable + 4 + 2 * index, true) : 0);
    const type = field(1) ? view.getUint8(table + field(1)) : 0;
    const bodyLength = field(3) ? Number(view.getBigInt64(table + field(3), true)) : 0;
    const next = position + 8 + metadataLength + bodyLength;
    if (next > bytes.length) break;
    out.types.push(type);
    if (type === RECORD_BATCH) sawBatch = true;
    if (!sawBatch && (type === SCHEMA || type === DICTIONARY_BATCH)) out.prefixEnd = next;
    position = next;
    out.end = next;
  }
  return out;
}

export class ArrowFollower implements Follower {
  private prefix?: Uint8Array;
  private readonly seen = new Seen();

  constructor(
    private readonly meta: SourceMetadata,
    private readonly source: ByteSource,
  ) {}

  get maxAgeMs(): number | undefined {
    return this.source.maxAgeMs;
  }

  async poll(signal?: AbortSignal): Promise<PollResult> {
    const result = await this.source.read(signal);
    if (!result || 'gone' in result) return { rows: [], ended: 'gone' in (result ?? {}) };
    if (result.whole) this.prefix = undefined;
    const walked = walkArrowMessages(result.bytes);
    let readable: Uint8Array;
    if (!this.prefix) {
      readable = result.bytes.subarray(0, walked.end);
      this.prefix = result.bytes.subarray(0, walked.prefixEnd);
      // dictionaries can grow, and would have to be kept: read everything again each time
      if (walked.types.includes(DICTIONARY_BATCH)) this.prefix = undefined;
    } else {
      const part = result.bytes.subarray(0, walked.end);
      readable = new Uint8Array(this.prefix.length + part.length);
      readable.set(this.prefix, 0);
      readable.set(part, this.prefix.length);
    }
    const rows: RawRow[] = [];
    if (walked.end > 0 && walked.types.length > 0 && walked.types.some((t) => t === RECORD_BATCH)) {
      for await (const row of arrowRows(this.meta, readable, { skip: 0, strict: false })) rows.push(row);
    }
    this.source.offset = this.prefix ? this.source.offset + walked.end : 0;
    return { rows: this.seen.fresh(rows), ended: walked.eos };
  }
}

/* ---------- RDF Message Log ---------- */

/** Where the last complete message of a Turtle or TriG log ends: after its `@message .` or `MESSAGE`. */
export function lastMessageEnd(text: string): number {
  const delimiter = /^[ \t]*(?:@message[ \t]*\.|MESSAGE)[ \t]*(?:\r?\n|$)/gim;
  let end = 0;
  for (let m = delimiter.exec(text); m; m = delimiter.exec(text)) {
    // a delimiter that reaches the end of the text without a line break may still be written
    if (m.index + m[0].length === text.length && !/\n$/.test(m[0])) break;
    end = m.index + m[0].length;
  }
  return end;
}

/** Appends to the preamble the prefix and base declarations of some complete messages. */
export function addDirectives(preamble: string, text: string): string {
  const lines = text.match(/^[ \t]*(?:@prefix|PREFIX|@base|BASE)\b[^\n]*$/gim) ?? [];
  return lines.length ? `${preamble}${lines.join('\n')}\n` : preamble;
}

export class RdfLogFollower implements Follower {
  private preamble = '';
  private first = true;

  constructor(
    private readonly source: ByteSource,
    private readonly baseIRI: string | undefined,
    /** Extracts the rows of the new quads. */
    private readonly rowsOf: (quads: Quad[]) => RawRow[],
    private readonly immutableIn: (quads: Quad[]) => boolean,
  ) {}

  get maxAgeMs(): number | undefined {
    return this.source.maxAgeMs;
  }

  async poll(signal?: AbortSignal): Promise<PollResult> {
    const result = await this.source.read(signal);
    if (!result || 'gone' in result) return { rows: [], ended: 'gone' in (result ?? {}) };
    if (result.whole) this.preamble = '';
    const text = new TextDecoder().decode(result.bytes);
    const end = lastMessageEnd(text);
    if (end === 0) return { rows: [], ended: false };
    const complete = text.slice(0, end);
    const messages = await parseLogMessages(result.whole ? complete : this.preamble + complete, { baseIRI: this.baseIRI });
    this.preamble = addDirectives(this.preamble, complete);
    this.source.offset = (result.whole ? 0 : this.source.offset) + new TextEncoder().encode(complete).length;
    const quads = messages.flat();
    const first = this.first;
    this.first = false;
    return {
      rows: this.rowsOf(quads),
      ended: this.immutableIn(quads),
      // the first read is the document the description was read from
      quads: first && result.whole ? undefined : quads,
      replaced: result.whole && !first,
    };
  }
}
