import { ValidationError } from '../errors.js';
import type { FieldMetadata, SnippetMetadata } from '../types.js';
import { decodeChunks } from './access.js';
import { makeRowConverter, type RawPoint } from './rows.js';

export interface CsvRow {
  cells: string[];
  /** False for a last row that is not ended by a line break: it may still be written. */
  terminated: boolean;
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

  for await (let chunk of chunks) {
    if (first) {
      first = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
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
          yield { cells: row, terminated: true };
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
  }
  if (row.length > 0 || field !== '' || fieldStarted) {
    row.push(field);
    yield { cells: row, terminated: false };
  }
}

/** The points of a CSV data file, after skipping the first `skip` data rows. */
export async function* csvPoints(
  meta: SnippetMetadata,
  bytes: AsyncIterable<Uint8Array>,
  options: { skip: number; strict: boolean },
): AsyncIterable<RawPoint> {
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
