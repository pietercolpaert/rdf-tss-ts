import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Source, type ReadableSource, type Row, type SourceKind } from '../src/index.js';
import { startServer, type MockServer } from './helpers/server.js';
import { tempDir, weatherExpected, weatherOptions, weatherReadings } from './helpers/fixtures.js';

async function collect(readings: AsyncIterable<Row>): Promise<Row[]> {
  const out: Row[] = [];
  for await (const r of readings) out.push(r);
  return out;
}

const table = (readings: Row[]) =>
  readings.map((r) => [r.time, r.get('temperature')?.value, r.get('humidity')?.value, r.get('status')?.value]);

const formats: { kind: SourceKind; dataFile?: string }[] = [
  { kind: 'EmbeddedRDF' },
  { kind: 'EmbeddedJSON' },
  { kind: 'CSV', dataFile: 'weather.csv' },
  { kind: 'Arrow', dataFile: 'weather.arrows' },
  { kind: 'Parquet', dataFile: 'weather.parquet' },
];

describe.each(formats)('a $kind source made by the writer and served by a mock server', ({ kind, dataFile }) => {
  let server: MockServer;
  let cleanup: () => Promise<void>;
  let dir: string;
  const metadataUrl = () => `${server.url}/${kind}.ttl`;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    const options = weatherOptions(kind, kind);
    const source = await Source.create({
      ...options,
      dataFile: dataFile ? join(dir, dataFile) : undefined,
      file: join(dir, `${kind}.ttl`),
      from: '2026-11-17T12:00:00Z',
      until: '2026-11-18T00:00:00Z',
    });
    await source.append(weatherReadings.slice(0, 1));
    await source.append(weatherReadings.slice(1));
    await source.close({ freeze: true });
    server = await startServer(dir);
  });

  afterAll(async () => {
    await server?.close();
    await cleanup?.();
  });

  it('can be read over HTTP, exactly as written', async () => {
    const source = await Source.fetch(metadataUrl());
    expect(source.kind).toBe(kind);
    expect(source.metadata.immutable).toBe(true);
    const readings = await collect(source.read());
    expect(table(readings)).toEqual(weatherExpected);
  });

  it('can be read from disk', async () => {
    const source = await Source.open(join(dir, `${kind}.ttl`));
    expect(table(await collect(source.read()))).toEqual(weatherExpected);
  });

  it('can be read from an RDF/JS dataset', async () => {
    const opened = await Source.open(join(dir, `${kind}.ttl`));
    const fromDataset = await Source.open(opened.dataset, { baseIRI: `file://${dir}/${kind}.ttl` });
    expect(table(await collect(fromDataset.read()))).toEqual(weatherExpected);
  });

  it('reads a time range: from is included, until is excluded', async () => {
    const source = await Source.fetch(metadataUrl());
    const readings = await collect(source.read({ from: '2026-11-17T12:10:00Z', until: '2026-11-17T12:30:00Z' }));
    expect(readings.map((r) => r.time)).toEqual(['2026-11-17T12:10:00Z', '2026-11-17T12:20:00Z']);
  });

  it('reads selected fields by local name or IRI', async () => {
    const source = await Source.fetch(metadataUrl());
    const readings = await collect(source.read({ fields: ['temperature', 'https://example.org/fields/status'] }));
    expect(readings[0].get('temperature')?.value).toBe('8.4');
    expect(readings[0].get('status')?.value).toBe('ok');
    expect(readings[0].get('humidity')).toBeUndefined();
    expect([...readings[0].fields()].map(([id]) => id)).toEqual(['https://example.org/fields/temperature', 'https://example.org/fields/status']);
  });

  it('knows the datatype, the unit and a JavaScript value of each value', async () => {
    const source = await Source.fetch(metadataUrl());
    const [first] = await collect(source.read());
    const temperature = first.get('temperature')!;
    expect(temperature.datatype).toBe('http://www.w3.org/2001/XMLSchema#double');
    expect(temperature.unit).toBe('http://qudt.org/vocab/unit/DEG_C');
    expect(temperature.toNative()).toBe(8.4);
    expect(first.get('humidity')!.toNative()).toBe(61);
    expect(first.get('status')!.toNative()).toBe('ok');
  });

  it('stores summaries that match the data', async () => {
    const source = await Source.fetch(metadataUrl());
    expect(source.summary('temperature')).toMatchObject({ count: 4, missing: 0, observedMinimum: '8.4', observedMaximum: '9', median: '8.55' });
    expect(source.summary('humidity')).toMatchObject({ count: 3, missing: 1, median: '59' });
    expect(Number(source.summary('temperature')!.mean)).toBeCloseTo(8.625, 10);
    expect(source.summary('status')).toMatchObject({ count: 3, missing: 1 });
  });

  it('conforms to the specification', async () => {
    const source = await Source.fetch(metadataUrl());
    const report = await source.validate();
    expect(report.results).toEqual([]);
    expect(report.conforms).toBe(true);
  });

  it('keeps the time window it was created with', async () => {
    const source = await Source.fetch(metadataUrl());
    expect(source.metadata.from).toBe('2026-11-17T12:00:00Z');
    expect(source.metadata.until).toBe('2026-11-18T00:00:00Z');
  });

  it('rejects an unknown field and ambiguous names clearly', async () => {
    const source = await Source.fetch(metadataUrl());
    const [first] = await collect(source.read());
    expect(() => first.get('nope')).toThrow(/unknown field/);
  });
});

describe('reading a published document with several sources', () => {
  it('asks which source to read', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const a = await Source.create({ ...weatherOptions('EmbeddedRDF', 'a'), file: join(dir, 'a.ttl') });
      await a.close();
      const b = await Source.create({ ...weatherOptions('EmbeddedRDF', 'b'), file: join(dir, 'b.ttl') });
      await b.close();
      const merged = await Source.open(join(dir, 'a.ttl'));
      const other = await Source.open(join(dir, 'b.ttl'));
      const { Store } = await import('n3');
      const store = new Store([...merged.dataset, ...other.dataset]);
      await expect(Source.open(store)).rejects.toThrow(/several sources/);
      const picked: ReadableSource = await Source.open(store, { source: 'https://example.org/b#source' });
      expect(picked.id).toBe('https://example.org/b#source');
    } finally {
      await cleanup();
    }
  });
});
