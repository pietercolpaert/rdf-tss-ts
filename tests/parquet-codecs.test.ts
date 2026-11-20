import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Source, type Row } from '../src/index.js';
import { tempDir } from './helpers/fixtures.js';

// Parquet files of other publishers are often compressed with ZSTD or Gzip, which hyparquet only
// reads with hyparquet-compressors.

const turtle = (file: string) => `
@prefix tss: <https://w3id.org/tss#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<#source> a tss:ParquetSource ; tss:dataFile <${file}> ; tss:timeField <#time> ; tss:hasField <#time>, <#temp> .
<#time> a tss:ContextField ; tss:columnName "time" ; tss:datatype xsd:dateTime .
<#temp> a tss:ValueField ; tss:columnName "temp" ; tss:datatype xsd:double .
`;

describe('Parquet files compressed with ZSTD or Gzip', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterAll(() => cleanup());

  it.each([
    { codec: 'ZSTD' as const, compress: (bytes: Uint8Array) => new Uint8Array(zstdCompressSync(bytes)) },
    { codec: 'GZIP' as const, compress: (bytes: Uint8Array) => new Uint8Array(gzipSync(bytes)) },
  ])('reads $codec', async ({ codec, compress }) => {
    const times = ['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z'];
    const buffer = parquetWriteBuffer({
      columnData: [
        { name: 'time', data: times, type: 'STRING' },
        { name: 'temp', data: [-4.9, -4.9, -5.2], type: 'DOUBLE' },
      ],
      codec,
      compressors: { [codec]: compress },
    });
    const name = `${codec.toLowerCase()}.parquet`;
    await writeFile(join(dir, name), new Uint8Array(buffer));
    await writeFile(join(dir, `${codec}.ttl`), turtle(name));
    const source = await Source.open(join(dir, `${codec}.ttl`), { localFiles: true });
    const rows: Row[] = [];
    for await (const row of source.read()) rows.push(row);
    expect(rows.map((r) => [r.time, r.get('temp')?.value])).toEqual([
      ['2026-01-01T00:00:00Z', '-4.9'],
      ['2026-01-01T01:00:00Z', '-4.9'],
      ['2026-01-01T02:00:00Z', '-5.2'],
    ]);
  });
});
