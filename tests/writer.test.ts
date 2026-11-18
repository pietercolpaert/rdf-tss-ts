import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockError, NotWritableError, Snippet, ValidationError, parseRdf, type Reading } from '../src/index.js';
import { ex, tempDir, weatherOptions, weatherReadings } from './helpers/fixtures.js';

async function all(it: AsyncIterable<Reading>): Promise<Reading[]> {
  const out: Reading[] = [];
  for await (const r of it) out.push(r);
  return out;
}

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

const csv = (name = 'w') => ({ ...weatherOptions('CSV', name), dataFile: join(dir, `${name}.csv`), file: join(dir, `${name}.ttl`) });
const times = async (path: string) => (await all((await Snippet.open(path)).read())).map((r) => r.time);

describe('appending', () => {
  it('checks datatypes, and changes nothing when a batch does not conform', async () => {
    const snippet = await Snippet.create(csv());
    await snippet.append(weatherReadings[0]);
    const before = await readFile(join(dir, 'w.csv'), 'utf8');
    const err = await snippet
      .append([
        { time: '2026-11-17T12:10:00Z', values: { temperature: '8.6' } },
        { time: '2026-11-17T12:20:00Z', values: { temperature: 'warm', humidity: '1.5' } },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.report.results.map((r: { rule: string }) => r.rule)).toEqual(['lexical-form', 'lexical-form']);
    expect(await readFile(join(dir, 'w.csv'), 'utf8')).toBe(before);
    expect(snippet.summary('temperature')!.count).toBe(1);
    await snippet.close();
    expect(await times(join(dir, 'w.ttl'))).toEqual(['2026-11-17T12:00:00Z']);
  });

  it('requires unique times that increase, and a time with a timezone', async () => {
    const snippet = await Snippet.create(csv());
    await snippet.append({ time: '2026-11-17T12:10:00Z', values: { temperature: '1' } });
    await expect(snippet.append({ time: '2026-11-17T12:10:00Z', values: {} })).rejects.toThrow(/unique and increase/);
    await expect(snippet.append({ time: '2026-11-17T12:00:00Z', values: {} })).rejects.toThrow(ValidationError);
    await expect(snippet.append([{ time: '2026-11-17T12:20:00Z', values: {} }, { time: '2026-11-17T12:20:00Z', values: {} }])).rejects.toThrow(ValidationError);
    await expect(snippet.append({ time: '2026-11-17T12:30:00', values: {} })).rejects.toThrow(/timezone/);
    await expect(snippet.append({ time: '2026-11-17T12:30:00Z', values: { nope: '1' } })).rejects.toThrow(/unknown field/);
    await snippet.close();
    expect(await times(join(dir, 'w.ttl'))).toEqual(['2026-11-17T12:10:00Z']);
  });

  it('takes Dates, numbers and null', async () => {
    const snippet = await Snippet.create(csv());
    await snippet.append({ time: new Date('2026-11-17T12:00:00Z'), values: { temperature: 8.5, humidity: 61n, status: null } });
    await snippet.close();
    const [reading] = await all((await Snippet.open(join(dir, 'w.ttl'))).read());
    expect(reading.time).toBe('2026-11-17T12:00:00Z');
    expect(reading.get('temperature')!.value).toBe('8.5');
    expect(reading.get('humidity')!.value).toBe('61');
    expect(reading.get('status')).toBeUndefined();
  });

  it('quotes text that needs it in CSV', async () => {
    const snippet = await Snippet.create(csv());
    await snippet.append({ time: '2026-11-17T12:00:00Z', values: { status: 'a, "quoted"\nline' } });
    await snippet.close();
    const [reading] = await all((await Snippet.open(join(dir, 'w.ttl'))).read());
    expect(reading.get('status')!.value).toBe('a, "quoted"\nline');
  });

  it('widens the time window and keeps committedUntil up to date', async () => {
    const snippet = await Snippet.create({ ...csv(), from: '2026-11-17T12:05:00Z', until: '2026-11-17T12:15:00Z' });
    const created = snippet.metadata.committedUntil!;
    await snippet.append({ time: '2026-11-17T12:00:00Z', values: { temperature: '1' } });
    expect(snippet.metadata.from).toBe('2026-11-17T12:00:00Z');
    expect(snippet.metadata.until).toBe('2026-11-17T12:15:00Z');
    await snippet.append({ time: '2026-11-17T12:30:00Z', values: { temperature: '2' } });
    expect(snippet.metadata.until).toBe('2026-11-17T12:30:01Z');
    expect(Date.parse(snippet.metadata.committedUntil!)).toBeGreaterThanOrEqual(Date.parse(created));
    await snippet.close();
    const reread = await Snippet.open(join(dir, 'w.ttl'));
    expect(reread.metadata.until).toBe('2026-11-17T12:30:01Z');
    expect((await reread.validate()).results).toEqual([]);
  });

  it('leaves an open side of the window open', async () => {
    const snippet = await Snippet.create(csv());
    await snippet.append(weatherReadings);
    expect(snippet.metadata.from).toBeUndefined();
    expect(snippet.metadata.until).toBeUndefined();
    await snippet.close();
  });

  it('recomputes summaries exactly', async () => {
    const snippet = await Snippet.create(csv());
    await snippet.append(weatherReadings);
    expect(snippet.summary('temperature')).toMatchObject({
      count: 4,
      missing: 0,
      firstTime: '2026-11-17T12:00:00Z',
      lastTime: '2026-11-17T12:30:00Z',
      observedMinimum: '8.4',
      observedMaximum: '9',
      median: '8.55',
    });
    expect(snippet.summary('humidity')).toMatchObject({ count: 3, missing: 1, firstTime: '2026-11-17T12:00:00Z', lastTime: '2026-11-17T12:30:00Z' });
    await snippet.close();
  });
});

describe('opening for writing', () => {
  it('continues a snippet that was left open, with its summaries and its last time', async () => {
    const first = await Snippet.create(csv());
    await first.append(weatherReadings.slice(0, 2));
    await first.close();

    const again = await Snippet.open(join(dir, 'w.ttl'), { write: true });
    await expect(again.append(weatherReadings[1])).rejects.toThrow(ValidationError);
    await again.append(weatherReadings.slice(2));
    expect(again.summary('temperature')!.count).toBe(4);
    await again.close();

    expect(await times(join(dir, 'w.ttl'))).toEqual(weatherReadings.map((r) => r.time));
  });

  it('allows one writer at a time', async () => {
    const writer = await Snippet.create(csv());
    await expect(Snippet.open(join(dir, 'w.ttl'), { write: true })).rejects.toThrow(LockError);
    await writer.close();
    const next = await Snippet.open(join(dir, 'w.ttl'), { write: true });
    await next.close();
  });

  it('replaces the lock of a process that is gone', async () => {
    const writer = await Snippet.create(csv());
    await writer.close();
    await writeFile(join(dir, 'w.ttl.lock'), JSON.stringify({ pid: 2 ** 22 - 1 }));
    const next = await Snippet.open(join(dir, 'w.ttl'), { write: true });
    await next.close();
    await expect(readFile(join(dir, 'w.ttl.lock'))).rejects.toThrow();
  });

  it('refuses an immutable snippet and a Parquet file', async () => {
    const csvSnippet = await Snippet.create(csv());
    await csvSnippet.append(weatherReadings);
    await csvSnippet.close({ freeze: true });
    await expect(Snippet.open(join(dir, 'w.ttl'), { write: true })).rejects.toThrow(NotWritableError);
    const closed = await Snippet.open(join(dir, 'w.ttl'));
    expect(closed.metadata.mutable).toBe(false);

    const parquet = await Snippet.create({ ...weatherOptions('Parquet', 'p'), dataFile: join(dir, 'p.parquet'), file: join(dir, 'p.ttl') });
    await parquet.append(weatherReadings);
    await parquet.close();
    expect((await Snippet.open(join(dir, 'p.ttl'))).metadata.mutable).toBe(false);
    await expect(Snippet.open(join(dir, 'p.ttl'), { write: true })).rejects.toThrow(NotWritableError);
  });

  it('cannot append to a snippet that was frozen', async () => {
    const snippet = await Snippet.create(csv());
    await snippet.close({ freeze: true });
    await expect(snippet.append(weatherReadings[0])).rejects.toThrow(NotWritableError);
  });

  it('releases the lock on close, also when called twice', async () => {
    const snippet = await Snippet.create(csv());
    await snippet.close();
    await snippet.close();
    await expect(readFile(join(dir, 'w.ttl.lock'))).rejects.toThrow();
  });
});

describe('every format keeps appending', () => {
  for (const [kind, ext] of [['CSV', 'csv'], ['Arrow', 'arrows'], ['EmbeddedRDF', ''], ['EmbeddedJSON', '']] as const) {
    it(`${kind}: batches added across sessions are all read`, async () => {
      const options = { ...weatherOptions(kind, kind), dataFile: ext ? join(dir, `a.${ext}`) : undefined, file: join(dir, `${kind}.ttl`) };
      const one = await Snippet.create(options);
      await one.append(weatherReadings.slice(0, 2));
      await one.close();
      const two = await Snippet.open(join(dir, `${kind}.ttl`), { write: true });
      await two.append(weatherReadings.slice(2, 3));
      await two.close();
      const three = await Snippet.open(join(dir, `${kind}.ttl`), { write: true });
      await three.append(weatherReadings.slice(3));
      await three.close({ freeze: true });
      const readings = await all((await Snippet.open(join(dir, `${kind}.ttl`))).read());
      expect(readings.map((r) => r.get('temperature')?.value)).toEqual(['8.4', '8.6', '8.5', '9']);
      expect((await (await Snippet.open(join(dir, `${kind}.ttl`))).validate()).results).toEqual([]);
    });
  }

  it('Arrow: the file stays a valid IPC stream that ends with the end-of-stream marker', async () => {
    const snippet = await Snippet.create({ ...weatherOptions('Arrow', 'a'), dataFile: join(dir, 'a.arrows') });
    await snippet.append(weatherReadings.slice(0, 2));
    await snippet.append(weatherReadings.slice(2));
    await snippet.close();
    const bytes = new Uint8Array(await readFile(join(dir, 'a.arrows')));
    expect([...bytes.slice(-8)]).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
    const arrow = await import('apache-arrow');
    const table = arrow.tableFromIPC(bytes);
    expect(table.numRows).toBe(4);
    expect(table.schema.fields.map((f) => f.name)).toEqual(['time', 'temp', 'hum', 'status']);
  });

  it('Arrow: reads the IPC file format of an immutable snippet, but does not write to it', async () => {
    const arrow = await import('apache-arrow');
    const table = arrow.tableFromArrays({ time: [Date.parse('2026-11-17T12:00:00Z'), Date.parse('2026-11-17T12:10:00Z')], value: [1.5, 2.5] });
    const typed = new arrow.Table({
      time: arrow.vectorFromArray([Date.parse('2026-11-17T12:00:00Z'), Date.parse('2026-11-17T12:10:00Z')], new arrow.TimestampMillisecond('UTC')),
      value: table.getChild('value')!,
    });
    await writeFile(join(dir, 'file.arrow'), arrow.tableToIPC(typed, 'file'));
    await writeFile(
      join(dir, 'file.ttl'),
      `@prefix tss: <https://w3id.org/tss#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix ex: <https://example.org/> .
ex:s a tss:ArrowSnippet ; tss:mutable false ; tss:committedUntil "2026-11-17T13:00:00Z"^^xsd:dateTimeStamp ;
  tss:dataFile <file.arrow> ; tss:timeField ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:Field ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:Field ; tss:columnName "value" ; tss:datatype xsd:double .`,
    );
    const snippet = await Snippet.open(join(dir, 'file.ttl'));
    const readings = await all(snippet.read());
    expect(readings.map((r) => [r.time, r.get('v')?.value])).toEqual([['2026-11-17T12:00:00Z', '1.5'], ['2026-11-17T12:10:00Z', '2.5']]);
    await expect(Snippet.open(join(dir, 'file.ttl'), { write: true })).rejects.toThrow(NotWritableError);
  });

  it('Parquet: is written when the snippet is closed, and frozen', async () => {
    const snippet = await Snippet.create({ ...weatherOptions('Parquet', 'p'), dataFile: join(dir, 'p.parquet'), file: join(dir, 'p.ttl') });
    await snippet.append(weatherReadings);
    expect(snippet.summary('temperature')!.count).toBe(4);
    await snippet.close();
    expect(await times(join(dir, 'p.ttl'))).toEqual(weatherReadings.map((r) => r.time));
    expect((await Snippet.open(join(dir, 'p.ttl'))).metadata.mutable).toBe(false);
  });
});

describe('serializing', () => {
  it('writes the metadata and embedded points in several syntaxes that read back the same', async () => {
    const snippet = await Snippet.create(weatherOptions('EmbeddedRDF', 'embedded'));
    await snippet.append(weatherReadings);
    for (const mediaType of ['text/turtle', 'application/trig', 'application/n-triples', 'application/n-quads', 'application/ld+json']) {
      const text = await snippet.serialize(mediaType);
      const store = await parseRdf(text, { contentType: mediaType });
      const readings = await all((await Snippet.open(store)).read());
      expect(readings.map((r) => r.get('temperature')?.value), mediaType).toEqual(['8.4', '8.6', '8.5', '9']);
    }
  });

  it('works without a metadata file: the data file is referred to relative to it', async () => {
    const snippet = await Snippet.create({ ...weatherOptions('CSV', 'solo'), dataFile: join(dir, 'solo.csv') });
    await snippet.append(weatherReadings);
    const turtle = await snippet.serialize();
    expect(turtle).toContain('<solo.csv>');
    await snippet.close();
    await writeFile(join(dir, 'solo.ttl'), turtle);
    expect(await times(join(dir, 'solo.ttl'))).toHaveLength(4);
  });

  it('puts the metadata file in another directory and refers to the data file relative to it', async () => {
    await mkdir(join(dir, 'meta'));
    const snippet = await Snippet.create({ ...weatherOptions('CSV', 'far'), dataFile: join(dir, 'data', 'far.csv'), file: join(dir, 'meta', 'far.ttl') });
    await snippet.append(weatherReadings);
    await snippet.close();
    expect(await readFile(join(dir, 'meta', 'far.ttl'), 'utf8')).toContain('<../data/far.csv>');
    expect(await times(join(dir, 'meta', 'far.ttl'))).toHaveLength(4);
    expect(ex).toBeTruthy();
  });
});
