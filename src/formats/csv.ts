import { ValidationError } from '../errors.js';
import type { FieldMetadata, SourceMetadata } from '../types.js';
import { decodeChunks } from './access.js';
import { makeRowConverter, type RawRow } from './rows.js';

export interface CsvRow {
  cells: string[];
  /** False for a last row that is not ended by a line break: it may still be written. */
  terminated: boolean;
  /** The number of characters up to and including the line break that ends the row (counting a byte order mark). */
  end: number;
}

/** A streaming RFC 4180 parser: quoted cells, doubled quotes, line breaks inside quotes. */
export async function* parseCsv(chunks: AsyncIterable<string>, delimiter = ','): AsyncGenerator<CsvRow> {
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoteSeen = false;
  let fieldStarted = false;
  let crPending = false;
  let first = true;
  let before = 0;

  for await (let chunk of chunks) {
    if (first) {
      first = false;
      if (chunk.charCodeAt(0) === 0xfeff) {
        chunk = chunk.slice(1);
        before = 1;
      }
    }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (crPending) {
        crPending = false;
        if (c === '\n') continue;
      }
      if (inQuotes) {
        if (quoteSeen) {
          if (c === '"') {
            field += '"';
            quoteSeen = false;
            continue;
          }
          inQuotes = false;
          quoteSeen = false;
        } else if (c === '"') {
          quoteSeen = true;
          continue;
        } else {
          field += c;
          continue;
        }
      }
      if (c === '"' && !fieldStarted) {
        inQuotes = true;
        fieldStarted = true;
        continue;
      }
      if (c === delimiter) {
        row.push(field);
        field = '';
        fieldStarted = false;
        continue;
      }
      if (c === '\n' || c === '\r') {
        if (row.length > 0 || field !== '' || fieldStarted) {
          row.push(field);
          yield { cells: row, terminated: true, end: before + i + 1 };
        }
        row = [];
        field = '';
        fieldStarted = false;
        if (c === '\r') crPending = true;
        continue;
      }
      field += c;
      fieldStarted = true;
    }
    before += chunk.length;
  }
  if (row.length > 0 || field !== '' || fieldStarted) {
    row.push(field);
    yield { cells: row, terminated: false, end: before };
  }
}

/** The columns of the fields in a CSV file: the position of each field's cells. */
export type CsvColumns = Map<string, number>;

function columnsOfHeader(meta: SourceMetadata, header: string[]): CsvColumns {
  const columns: CsvColumns = new Map();
  for (const f of meta.fields) {
    if (f.columnName === undefined) continue;
    const index = header.indexOf(f.columnName);
    if (index < 0) throw new ValidationError(`the CSV file has no column ${JSON.stringify(f.columnName)} for field ${f.id}`);
    columns.set(f.id, index);
  }
  return columns;
}

/**
 * Read the complete records of (a part of) a CSV file that start at a record. `columns` are
 * those of the header, when the text does not start with it. Returns the rows, the columns
 * and the number of characters of the complete records: the next part starts there.
 */
export async function parseCsvText(
  meta: SourceMetadata,
  text: string,
  columns?: CsvColumns,
): Promise<{ rows: RawRow[]; columns?: CsvColumns; consumed: number }> {
  const convert = makeRowConverter(meta);
  let known = columns;
  if (!meta.header && !known) {
    known = new Map();
    for (const f of meta.fields) if (f.columnIndex !== undefined) known.set(f.id, f.columnIndex);
  }
  const rows: RawRow[] = [];
  let consumed = 0;
  async function* one() {
    yield text;
  }
  let rowNumber = 0;
  for await (const row of parseCsv(one(), meta.delimiter)) {
    if (!row.terminated) break;
    consumed = row.end;
    if (!known) {
      known = columnsOfHeader(meta, row.cells);
      continue;
    }
    rowNumber++;
    const index = known;
    const access = (f: FieldMetadata): string | undefined => {
      const at = index.get(f.id);
      if (at === undefined) return undefined;
      const cell = row.cells[at];
      return cell === undefined || cell === '' ? undefined : cell;
    };
    rows.push(convert(access, rowNumber));
  }
  return { rows, columns: known, consumed };
}

/** The rows of a CSV data file, after skipping the first `skip` data rows. */
export async function* csvRows(
  meta: SourceMetadata,
  bytes: AsyncIterable<Uint8Array>,
  options: { skip: number; strict: boolean },
): AsyncIterable<RawRow> {
  const convert = makeRowConverter(meta);
  const columns = new Map<string, number>();
  let headerSeen = !meta.header;
  let rowNumber = 0;

  if (!meta.header) {
    for (const f of meta.fields) if (f.columnIndex !== undefined) columns.set(f.id, f.columnIndex);
  }

  for await (const row of parseCsv(decodeChunks(bytes, meta.encoding), meta.delimiter)) {
    if (!row.terminated && options.strict) return;
    if (!headerSeen) {
      headerSeen = true;
      for (const f of meta.fields) {
        if (f.columnName === undefined) continue;
        const index = row.cells.indexOf(f.columnName);
        if (index < 0) {
          throw new ValidationError(`the CSV file has no column ${JSON.stringify(f.columnName)} for field ${f.id}`);
        }
        columns.set(f.id, index);
      }
      continue;
    }
    rowNumber++;
    if (rowNumber <= options.skip) continue;
    const access = (f: FieldMetadata): string | undefined => {
      const index = columns.get(f.id);
      if (index === undefined) return undefined;
      const cell = row.cells[index];
      return cell === undefined || cell === '' ? undefined : cell;
    };
    yield convert(access, rowNumber);
  }
}
