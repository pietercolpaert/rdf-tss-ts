import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Snippet, type ReadableSnippet, type Reading, type SnippetKind } from '../src/index.js';
import { startServer, type MockServer } from './helpers/server.js';
import { tempDir, weatherExpected, weatherOptions, weatherReadings } from './helpers/fixtures.js';

async function collect(readings: AsyncIterable<Reading>): Promise<Reading[]> {
  const out: Reading[] = [];
  for await (const r of readings) out.push(r);
  return out;
}

const table = (readings: Reading[]) =>
  readings.map((r) => [r.time, r.get('temperature')?.value, r.get('humidity')?.value, r.get('status')?.value]);

const formats: { kind: SnippetKind; dataFile?: string }[] = [
  { kind: 'EmbeddedRDF' },
  { kind: 'EmbeddedJSON' },
  { kind: 'CSV', dataFile: 'weather.csv' },
  { kind: 'Arrow', dataFile: 'weather.arrows' },
  { kind: 'Parquet', dataFile: 'weather.parquet' },
];

describe.each(formats)('a $kind snippet made by the writer and served by a mock server', ({ kind, dataFile }) => {
  let server: MockServer;
  let cleanup: () => Promise<void>;
  let dir: string;
  const metadataUrl = () => `${server.url}/${kind}.ttl`;

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    const options = weatherOptions(kind, kind);
    const snippet = await Snippet.create({
      ...options,
      dataFile: dataFile ? join(dir, dataFile) : undefined,
      file: join(dir, `${kind}.ttl`),
      from: '2026-11-17T12:00:00Z',
      until: '2026-11-18T00:00:00Z',
    });
    await snippet.append(weatherReadings.slice(0, 1));
    await snippet.append(weatherReadings.slice(1));
    await snippet.close({ freeze: true });
    server = await startServer(dir);
  });

  afterAll(async () => {
    await server?.close();
    await cleanup?.();
  });

  it('can be read over HTTP, exactly as written', async () => {
    const snippet = await Snippet.fetch(metadataUrl());
    expect(snippet.kind).toBe(kind);
    expect(snippet.metadata.immutable).toBe(true);
    const readings = await collect(snippet.read());
    expect(table(readings)).toEqual(weatherExpected);
  });

  it('can be read from disk', async () => {
    const snippet = await Snippet.open(join(dir, `${kind}.ttl`));
    expect(table(await collect(snippet.read()))).toEqual(weatherExpected);
  });

  it('can be read from an RDF/JS dataset', async () => {
    const opened = await Snippet.open(join(dir, `${kind}.ttl`));
    const fromDataset = await Snippet.open(opened.dataset, { baseIRI: `file://${dir}/${kind}.ttl` });
    expect(table(await collect(fromDataset.read()))).toEqual(weatherExpected);
  });

  it('reads a time range: from is included, until is excluded', async () => {
    const snippet = await Snippet.fetch(metadataUrl());
    const readings = await collect(snippet.read({ from: '2026-11-17T12:10:00Z', until: '2026-11-17T12:30:00Z' }));
    expect(readings.map((r) => r.time)).toEqual(['2026-11-17T12:10:00Z', '2026-11-17T12:20:00Z']);
  });

  it('reads selected fields by local name or IRI', async () => {
    const snippet = await Snippet.fetch(metadataUrl());
    const readings = await collect(snippet.read({ fields: ['temperature', 'https://example.org/fields/status'] }));
    expect(readings[0].get('temperature')?.value).toBe('8.4');
    expect(readings[0].get('status')?.value).toBe('ok');
    expect(readings[0].get('humidity')).toBeUndefined();
    expect([...readings[0].fields()].map(([id]) => id)).toEqual(['https://example.org/fields/temperature', 'https://example.org/fields/status']);
  });

  it('knows the datatype, the unit and a JavaScript value of each value', async () => {
    const snippet = await Snippet.fetch(metadataUrl());
    const [first] = await collect(snippet.read());
    const temperature = first.get('temperature')!;
    expect(temperature.datatype).toBe('http://www.w3.org/2001/XMLSchema#double');
    expect(temperature.unit).toBe('http://qudt.org/vocab/unit/DEG_C');
    expect(temperature.toNative()).toBe(8.4);
    expect(first.get('humidity')!.toNative()).toBe(61);
    expect(first.get('status')!.toNative()).toBe('ok');
  });

  it('stores summaries that match the data', async () => {
    const snippet = await Snippet.fetch(metadataUrl());
    expect(snippet.summary('temperature')).toMatchObject({ count: 4, missing: 0, observedMinimum: '8.4', observedMaximum: '9', median: '8.55' });
    expect(snippet.summary('humidity')).toMatchObject({ count: 3, missing: 1, median: '59' });
    expect(Number(snippet.summary('temperature')!.mean)).toBeCloseTo(8.625, 10);
    expect(snippet.summary('status')).toMatchObject({ count: 3, missing: 1 });
  });

  it('conforms to the specification', async () => {
    const snippet = await Snippet.fetch(metadataUrl());
    const report = await snippet.validate();
    expect(report.results).toEqual([]);
    expect(report.conforms).toBe(true);
  });

  it('keeps the time window it was created with', async () => {
    const snippet = await Snippet.fetch(metadataUrl());
    expect(snippet.metadata.from).toBe('2026-11-17T12:00:00Z');
    expect(snippet.metadata.until).toBe('2026-11-18T00:00:00Z');
  });

  it('rejects an unknown field and ambiguous names clearly', async () => {
    const snippet = await Snippet.fetch(metadataUrl());
    const [first] = await collect(snippet.read());
    expect(() => first.get('nope')).toThrow(/unknown field/);
  });
});

describe('reading a published document with several snippets', () => {
  it('asks which snippet to read', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const a = await Snippet.create({ ...weatherOptions('EmbeddedRDF', 'a'), file: join(dir, 'a.ttl') });
      await a.close();
      const b = await Snippet.create({ ...weatherOptions('EmbeddedRDF', 'b'), file: join(dir, 'b.ttl') });
      await b.close();
      const merged = await Snippet.open(join(dir, 'a.ttl'));
      const other = await Snippet.open(join(dir, 'b.ttl'));
      const { Store } = await import('n3');
      const store = new Store([...merged.dataset, ...other.dataset]);
      await expect(Snippet.open(store)).rejects.toThrow(/several snippets/);
      const picked: ReadableSnippet = await Snippet.open(store, { snippet: 'https://example.org/b#snippet' });
      expect(picked.id).toBe('https://example.org/b#snippet');
    } finally {
      await cleanup();
    }
  });
});
