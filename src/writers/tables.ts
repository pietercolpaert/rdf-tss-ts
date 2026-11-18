import { isIntegerDatatype } from '../lexical.js';
import { xsd } from '../ns.js';
import { instantOf } from '../time.js';
import type { FieldMetadata } from '../types.js';

/** One point to write: the time and the lexical values by field id. */
export interface RowToWrite {
  time: string;
  values: Map<string, string>;
}

type ColumnKind = 'timestamp' | 'double' | 'float' | 'integer' | 'boolean' | 'text';

function columnKind(field: FieldMetadata, isTime: boolean): ColumnKind {
  if (isTime) return 'timestamp';
  if (field.datatype === xsd('double')) return 'double';
  if (field.datatype === xsd('float')) return 'float';
  if (isIntegerDatatype(field.datatype)) return 'integer';
  if (field.datatype === xsd('boolean')) return 'boolean';
  return 'text';
}

function parseFloatText(text: string): number {
  if (text === 'INF' || text === '+INF') return Infinity;
  if (text === '-INF') return -Infinity;
  return Number(text);
}

export interface Column {
  name: string;
  kind: ColumnKind;
  data: (string | number | bigint | boolean | Date | null)[];
}

/** The columns of a table of points, in the order of `fields` (the time field first). */
export function tableColumns(timeField: FieldMetadata, fields: FieldMetadata[], rows: RowToWrite[]): Column[] {
  const columns: Column[] = [{ name: timeField.columnName ?? timeField.localName, kind: 'timestamp', data: [] }];
  for (const f of fields) columns.push({ name: f.columnName ?? f.localName, kind: columnKind(f, false), data: [] });
  for (const row of rows) {
    columns[0].data.push(new Date(Number(instantOf(row.time) / 1_000_000n)));
    fields.forEach((f, index) => {
      const text = row.values.get(f.id);
      const column = columns[index + 1];
      if (text === undefined) column.data.push(null);
      else if (column.kind === 'double' || column.kind === 'float') column.data.push(parseFloatText(text));
      else if (column.kind === 'integer') column.data.push(BigInt(text));
      else if (column.kind === 'boolean') column.data.push(text === 'true' || text === '1');
      else column.data.push(text);
    });
  }
  return columns;
}

/**
 * Encode rows as Arrow IPC streaming format: the schema message, the record batch and
 * the end-of-stream marker.
 */
export async function arrowStreamBytes(columns: Column[]): Promise<Uint8Array> {
  const arrow = await import('apache-arrow');
  const types: Record<ColumnKind, () => import('apache-arrow').DataType> = {
    timestamp: () => new arrow.TimestampMillisecond('UTC'),
    double: () => new arrow.Float64(),
    float: () => new arrow.Float32(),
    integer: () => new arrow.Int64(),
    boolean: () => new arrow.Bool(),
    text: () => new arrow.Utf8(),
  };
  const vectors: Record<string, import('apache-arrow').Vector> = {};
  for (const c of columns) {
    const data = c.kind === 'timestamp' ? c.data.map((d) => (d instanceof Date ? d.getTime() : d)) : c.data;
    vectors[c.name] = arrow.vectorFromArray(data as never, types[c.kind]());
  }
  return arrow.tableToIPC(new arrow.Table(vectors), 'stream');
}

const EOS = [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0];

export function endsWithEos(tail: Uint8Array): boolean {
  return tail.length >= 8 && EOS.every((b, i) => tail[tail.length - 8 + i] === b);
}

export const EOS_BYTES = new Uint8Array(EOS);

/** The bytes after the schema message and before the end-of-stream marker: the record batches. */
export function recordBatchMessages(stream: Uint8Array): Uint8Array {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  if (view.getUint32(0, true) !== 0xffffffff) throw new Error('not an Arrow IPC stream');
  const schemaLength = 8 + view.getInt32(4, true);
  const end = endsWithEos(stream) ? stream.length - 8 : stream.length;
  return stream.subarray(schemaLength, end);
}

/** Encode rows as a Parquet file. */
export async function parquetBytes(columns: Column[]): Promise<Uint8Array> {
  const { parquetWriteBuffer } = await import('hyparquet-writer');
  const types = { timestamp: 'TIMESTAMP', double: 'DOUBLE', float: 'FLOAT', integer: 'INT64', boolean: 'BOOLEAN', text: 'STRING' } as const;
  const buffer = parquetWriteBuffer({
    columnData: columns.map((c) => ({ name: c.name, data: c.data as never, type: types[c.kind] })),
  });
  return new Uint8Array(buffer);
}

