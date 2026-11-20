import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Source, ValidationError, type ReadableSource, type Row } from '../src/index.js';
import { startServer, type MockServer } from './helpers/server.js';
import { tempDir, weatherOptions, weatherReadings } from './helpers/fixtures.js';

// A time grid without a step field: the step of a row is its position in the data file.

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

const all = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const r of it) out.push(r);
  return out;
};

/** A source on a time grid of `step` from `base`, with a temperature column and no step column. */
const gridTurtle = (cls: string, dataFile: string, { base = '2030-01-01T00:00:00Z', step = 'P1M', immutable = true } = {}) => `
@prefix tss: <https://w3id.org/tss#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<#source> a tss:${cls} ;
    ${immutable ? 'tss:immutable true ;' : ''}
    tss:dataFile <${dataFile}> ;
    tss:timeBase "${base}"^^xsd:dateTime ;
    tss:timeStep "${step}"^^xsd:duration ;
    tss:timeField <#time> ;
    tss:hasField <#time>, <#temp> .
<#time> a tss:ContextField ; tss:datatype xsd:dateTime .
<#temp> a tss:ValueField ; tss:columnName "temp" ; tss:datatype xsd:double .
`;

const MONTHS = ['2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z', '2030-03-01T00:00:00Z', '2030-04-01T00:00:00Z'];
const temperatures = (rows: Row[]) => rows.map((r) => r.get('temp')?.value);

describe('a time grid without a step field', () => {
  it.each([
    { kind: 'Arrow' as const, cls: 'ArrowSource', file: 'w.arrows' },
    { kind: 'Parquet' as const, cls: 'ParquetSource', file: 'w.parquet' },
    { kind: 'CSV' as const, cls: 'CSVSource', file: 'w.csv' },
  ])('$kind: counts the rows of the file, in calendar months', async ({ kind, cls, file }) => {
    // the data file has a time column too; the grid does not read it
    const writer = await Source.create({ ...weatherOptions(kind, 'w'), dataFile: join(dir, file) });
    await writer.append(weatherReadings);
    await writer.close({ freeze: true });
    await writeFile(join(dir, 'grid.ttl'), gridTurtle(cls, file));
    const source = await Source.open(join(dir, 'grid.ttl'), { localFiles: true });
    const rows = await all(source.read());
    expect(rows.map((r) => r.time)).toEqual(MONTHS);
    expect(temperatures(rows)).toEqual(['8.4', '8.6', '8.5', '9']);
    expect((await source.validate()).results).toEqual([]);
  });

  it('a follower keeps count of the rows it read, so the rows of a Range request are at the next steps', async () => {
    const server: MockServer = await startServer(dir);
    try {
      await writeFile(join(dir, 'f.csv'), 'temp\n1\n2\n');
      await writeFile(join(dir, 'f.ttl'), gridTurtle('CSVSource', 'f.csv', { immutable: false }));
      const source: ReadableSource = await Source.fetch(`${server.url}/f.ttl`);
      const controller = new AbortController();
      const seen: Row[] = [];
      const done = (async () => {
        try {
          for await (const r of source.read({ follow: { interval: 'PT0.05S' }, signal: controller.signal })) seen.push(r);
        } catch {
          // aborted
        }
      })();
      const until = async (count: number) => {
        for (let i = 0; i < 400 && seen.length < count; i++) await new Promise((r) => setTimeout(r, 25));
        expect(seen.length).toBeGreaterThanOrEqual(count);
      };
      await until(2);
      await appendFile(join(dir, 'f.csv'), '3\n4\n');
      await until(4);
      controller.abort();
      await done;
      expect(seen.map((r) => [r.time, r.get('temp')?.value])).toEqual(MONTHS.map((time, i) => [time, String(i + 1)]));
      expect(server.requests.some((r) => r.path === '/f.csv' && r.range && r.status === 206)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('the writer adds a row of empty values for every step without readings', async () => {
    await writeFile(join(dir, 'g.csv'), 'temp\n');
    await writeFile(join(dir, 'g.ttl'), gridTurtle('CSVSource', 'g.csv', { base: '2030-01-01T00:00:00Z', step: 'PT1H', immutable: false }));
    const writer = await Source.open(join(dir, 'g.ttl'), { write: true });
    await expect(writer.append({ time: '2030-01-01T00:30:00Z', values: { temp: 1 } })).rejects.toThrow(/not on the time grid/);
    await writer.append([
      { time: '2030-01-01T00:00:00Z', values: { temp: 1 } },
      { time: '2030-01-01T02:00:00Z', values: { temp: 2 } },
    ]);
    await writer.close();

    // a writer that opens the file again continues at the step after its last row
    const again = await Source.open(join(dir, 'g.ttl'), { write: true });
    await expect(again.append({ time: '2030-01-01T01:00:00Z', values: { temp: 9 } })).rejects.toThrow(ValidationError);
    await again.append({ time: '2030-01-01T04:00:00Z', values: { temp: 3 } });
    await again.close({ freeze: true });

    expect(await readFile(join(dir, 'g.csv'), 'utf8')).toBe('temp\n1\n""\n2\n""\n3\n');
    const rows = (await all((await Source.open(join(dir, 'g.ttl'))).read())).filter((r) => r.get('temp'));
    expect(rows.map((r) => [r.time, r.get('temp')?.value])).toEqual([
      ['2030-01-01T00:00:00Z', '1'],
      ['2030-01-01T02:00:00Z', '2'],
      ['2030-01-01T04:00:00Z', '3'],
    ]);
  });
});
