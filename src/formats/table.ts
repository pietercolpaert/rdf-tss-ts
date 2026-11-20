import { ValidationError } from '../errors.js';
import { isFloatDatatype, isIntegerDatatype, numberToLexical } from '../lexical.js';
import { formatInstant } from '../time.js';
import type { FieldMetadata, SourceMetadata } from '../types.js';
import { makeRowConverter, type RawRow } from './rows.js';

/** A `Date` as `YYYY-MM-DDThh:mm:ss[.fraction]Z`; `utc: false` leaves out the `Z`. */
export function dateToLexical(date: Date, utc = true): string {
  const text = formatInstant(BigInt(date.getTime()) * 1_000_000n);
  return utc ? text : text.replace(/Z$/, '');
}

function dateOnly(date: Date): string {
  return dateToLexical(date).slice(0, 10);
}

function timeOfDay(nanos: bigint): string {
  const day = 86_400_000_000_000n;
  const n = ((nanos % day) + day) % day;
  const seconds = Number(n / 1_000_000_000n);
  const fraction = n % 1_000_000_000n;
  const pad = (x: number) => String(x).padStart(2, '0');
  const base = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  return fraction ? `${base}.${fraction.toString().padStart(9, '0').replace(/0+$/, '')}` : base;
}

function signedFromWords(words: ArrayLike<number>): bigint {
  let value = 0n;
  for (let k = 0; k < words.length; k++) value |= BigInt(words[k] >>> 0) << BigInt(32 * k);
  const bits = BigInt(32 * words.length);
  return value >= 1n << (bits - 1n) ? value - (1n << bits) : value;
}

function withScale(int: bigint, scale: number): string {
  const negative = int < 0n;
  const digits = (negative ? -int : int).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return (negative ? '-' : '') + whole + (scale > 0 ? '.' + fraction : '');
}

/** The lexical form of a value of an Arrow type, as in spec § 6.3. */
export function arrowCellToLexical(arrow: typeof import('apache-arrow'), vector: import('apache-arrow').Vector, index: number): string | undefined {
  const value = vector.get(index);
  if (value === null || value === undefined) return undefined;
  let type = vector.type;
  if (arrow.DataType.isDictionary(type)) type = type.dictionary;
  if (arrow.DataType.isBool(type)) return value ? 'true' : 'false';
  if (arrow.DataType.isInt(type)) return String(value);
  if (arrow.DataType.isFloat(type)) return numberToLexical(Number(value));
  if (arrow.DataType.isDecimal(type)) return withScale(signedFromWords(value as Uint32Array), type.scale);
  if (arrow.DataType.isUtf8(type) || arrow.DataType.isLargeUtf8(type)) return value === '' ? undefined : String(value);
  if (arrow.DataType.isDate(type)) return dateOnly(new Date(Number(value)));
  if (arrow.DataType.isTimestamp(type)) return dateToLexical(new Date(Number(value)), !!type.timezone);
  if (arrow.DataType.isTime(type)) {
    const factor = [1_000_000_000n, 1_000_000n, 1_000n, 1n][type.unit] ?? 1n;
    return timeOfDay(BigInt(value as bigint | number) * factor);
  }
  return String(value);
}

/**
 * The rows of an Arrow data file in the IPC streaming or the IPC file format. `rowsBefore` is
 * the number of rows before the record batches of `bytes`, when they are a part of a stream.
 */
export async function* arrowRows(
  meta: SourceMetadata,
  bytes: Uint8Array,
  options: { skip: number; strict: boolean; rowsBefore?: number },
): AsyncIterable<RawRow> {
  const arrow = await import('apache-arrow');
  const convert = makeRowConverter(meta);
  const reader = arrow.RecordBatchReader.from(bytes);
  let rowNumber = options.rowsBefore ?? 0;
  try {
    for (const batch of reader) {
      const columns = new Map<string, import('apache-arrow').Vector>();
      for (const f of meta.fields) {
        if (f.columnName === undefined) continue;
        const column = batch.getChild(f.columnName);
        if (!column) throw new ValidationError(`the Arrow file has no column ${JSON.stringify(f.columnName)} for field ${f.id}`);
        columns.set(f.id, column);
      }
      for (let i = 0; i < batch.numRows; i++) {
        rowNumber++;
        if (rowNumber - (options.rowsBefore ?? 0) <= options.skip) continue;
        const access = (f: FieldMetadata) => {
          const column = columns.get(f.id);
          return column ? arrowCellToLexical(arrow, column, i) : undefined;
        };
        yield convert(access, rowNumber);
      }
    }
  } catch (error) {
    // A stream that is being written can end in the middle of a message.
    if (error instanceof ValidationError || !options.strict) throw error;
  }
}

/** The lexical form of a value read from a Parquet file. */
export function parquetCellToLexical(value: unknown, datatype: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (isFloatDatatype(datatype)) return numberToLexical(value);
    if (isIntegerDatatype(datatype) && Number.isInteger(value)) return String(value);
    return numberToLexical(value);
  }
  if (value instanceof Date) return dateToLexical(value);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

/**
 * The decompressors of hyparquet-compressors (ZSTD, Gzip, Brotli, LZ4), when it is installed:
 * hyparquet itself only reads uncompressed and Snappy pages.
 */
let compressors: Promise<Record<string, unknown> | undefined> | undefined;
const loadCompressors = () =>
  (compressors ??= import('hyparquet-compressors').then(
    (module) => (module as { compressors: Record<string, unknown> }).compressors,
    () => undefined,
  ));

/** The rows of a Parquet data file. */
export async function* parquetRows(
  meta: SourceMetadata,
  bytes: Uint8Array,
  options: { skip: number },
): AsyncIterable<RawRow> {
  const { parquetReadObjects } = await import('hyparquet');
  const convert = makeRowConverter(meta);
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const columns = meta.fields.map((f) => f.columnName).filter((name): name is string => name !== undefined);
  const extra = await loadCompressors();
  let rows: Record<string, unknown>[];
  try {
    rows = (await parquetReadObjects({ file, columns, ...(extra ? { compressors: extra } : {}) })) as Record<string, unknown>[];
  } catch (error) {
    const codec = /unsupported compression codec: (\w+)/.exec((error as Error).message)?.[1];
    if (codec && !extra) throw new Error(`the Parquet file is compressed with ${codec}: npm install hyparquet-compressors to read it`);
    throw error;
  }
  for (let i = 0; i < rows.length; i++) {
    if (i < options.skip) continue;
    const row = rows[i];
    const access = (f: FieldMetadata) => (f.columnName === undefined ? undefined : parquetCellToLexical(row[f.columnName], f.datatype));
    yield convert(access, i + 1);
  }
}
