import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockError, NotWritableError, Source, ValidationError, parseRdf, type Row } from '../src/index.js';
import { ex, tempDir, weatherOptions, weatherReadings } from './helpers/fixtures.js';

async function all(it: AsyncIterable<Row>): Promise<Row[]> {
  const out: Row[] = [];
  for await (const r of it) out.push(r);
  return out;
}

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

const csv = (name = 'w') => ({ ...weatherOptions('CSV', name), dataFile: join(dir, `${name}.csv`), file: join(dir, `${name}.ttl`) });
const times = async (path: string) => (await all((await Source.open(path)).read())).map((r) => r.time);

describe('appending', () => {
  it('checks datatypes, and changes nothing when a batch does not conform', async () => {
    const source = await Source.create(csv());
    await source.append(weatherReadings[0]);
    const before = await readFile(join(dir, 'w.csv'), 'utf8');
    const err = await source
      .append([
        { time: '2026-11-17T12:10:00Z', values: { temperature: '8.6' } },
        { time: '2026-11-17T12:20:00Z', values: { temperature: 'warm', humidity: '1.5' } },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.report.results.map((r: { rule: string }) => r.rule)).toEqual(['lexical-form', 'lexical-form']);
    expect(await readFile(join(dir, 'w.csv'), 'utf8')).toBe(before);
    await source.close();
    expect(await times(join(dir, 'w.ttl'))).toEqual(['2026-11-17T12:00:00Z']);
  });

  it('requires unique times that increase, and a time with a timezone', async () => {
    const source = await Source.create(csv());
    await source.append({ time: '2026-11-17T12:10:00Z', values: { temperature: '1' } });
    await expect(source.append({ time: '2026-11-17T12:10:00Z', values: {} })).rejects.toThrow(/unique and increase/);
    await expect(source.append({ time: '2026-11-17T12:00:00Z', values: {} })).rejects.toThrow(ValidationError);
    await expect(source.append([{ time: '2026-11-17T12:20:00Z', values: {} }, { time: '2026-11-17T12:20:00Z', values: {} }])).rejects.toThrow(ValidationError);
    await expect(source.append({ time: '2026-11-17T12:30:00', values: {} })).rejects.toThrow(/timezone/);
    await expect(source.append({ time: '2026-11-17T12:30:00Z', values: { nope: '1' } })).rejects.toThrow(/unknown field/);
    await source.close();
    expect(await times(join(dir, 'w.ttl'))).toEqual(['2026-11-17T12:10:00Z']);
  });

  it('takes Dates, numbers and null', async () => {
    const source = await Source.create(csv());
    await source.append({ time: new Date('2026-11-17T12:00:00Z'), values: { temperature: 8.5, humidity: 61n, status: null } });
    await source.close();
    const [reading] = await all((await Source.open(join(dir, 'w.ttl'))).read());
    expect(reading.time).toBe('2026-11-17T12:00:00Z');
    expect(reading.get('temperature')!.value).toBe('8.5');
    expect(reading.get('humidity')!.value).toBe('61');
    expect(reading.get('status')).toBeUndefined();
  });

  it('quotes text that needs it in CSV', async () => {
    const source = await Source.create(csv());
    await source.append({ time: '2026-11-17T12:00:00Z', values: { status: 'a, "quoted"\nline' } });
    await source.close();
    const [reading] = await all((await Source.open(join(dir, 'w.ttl'))).read());
    expect(reading.get('status')!.value).toBe('a, "quoted"\nline');
  });

  it('keeps the time window it was created with, and refuses a time outside of it', async () => {
    const source = await Source.create({ ...csv(), from: '2026-11-17T12:00:00Z', until: '2026-11-17T12:15:00Z' });
    await source.append({ time: '2026-11-17T12:00:00Z', values: { temperature: '1' } });
    await expect(source.append({ time: '2026-11-17T12:30:00Z', values: { temperature: '2' } })).rejects.toThrow(ValidationError);
    await expect(source.append({ time: '2026-11-17T11:59:00Z', values: { temperature: '2' } })).rejects.toThrow(ValidationError);
    expect(source.metadata.from).toBe('2026-11-17T12:00:00Z');
    expect(source.metadata.until).toBe('2026-11-17T12:15:00Z');
    await source.close();
    const reread = await Source.open(join(dir, 'w.ttl'));
    expect(reread.metadata.until).toBe('2026-11-17T12:15:00Z');
    expect(await times(join(dir, 'w.ttl'))).toEqual(['2026-11-17T12:00:00Z']);
  });

  it('writes no summaries while the source grows, and adds them with tss:immutable when it ends', async () => {
    const source = await Source.create(csv());
    await source.append(weatherReadings);
    const growing = await readFile(join(dir, 'w.ttl'), 'utf8');
    expect(growing).not.toContain('tss:summary');
    expect(growing).not.toContain('immutable');
    expect(growing).not.toContain('committedUntil');
    await source.close({ freeze: true });
    const ended = await readFile(join(dir, 'w.ttl'), 'utf8');
    expect(ended).toContain('tss:immutable true');
    expect(ended).toContain('tss:summary');
    expect(ended).not.toContain('committedUntil');
  });

  it('leaves an open side of the window open', async () => {
    const source = await Source.create(csv());
    await source.append(weatherReadings);
    expect(source.metadata.from).toBeUndefined();
    expect(source.metadata.until).toBeUndefined();
    await source.close();
  });

  it('computes the summaries over the whole source when it ends', async () => {
    const source = await Source.create(csv());
    await source.append(weatherReadings);
    await source.close({ freeze: true });
    const ended = await Source.open(join(dir, 'w.ttl'));
    expect(ended.summary('temperature')).toMatchObject({
      count: 4,
      missing: 0,
      firstTime: '2026-11-17T12:00:00Z',
      lastTime: '2026-11-17T12:30:00Z',
      observedMinimum: '8.4',
      observedMaximum: '9',
      median: '8.55',
    });
    expect(ended.summary('humidity')).toMatchObject({ count: 3, missing: 1, firstTime: '2026-11-17T12:00:00Z', lastTime: '2026-11-17T12:30:00Z' });
  });
});

describe('opening for writing', () => {
  it('continues a source that was left open, from its last time, and summarizes all of it when it ends', async () => {
    const first = await Source.create(csv());
    await first.append(weatherReadings.slice(0, 2));
    await first.close();

    const again = await Source.open(join(dir, 'w.ttl'), { write: true });
    await expect(again.append(weatherReadings[1])).rejects.toThrow(ValidationError);
    await again.append(weatherReadings.slice(2));
    await again.close({ freeze: true });
    expect((await Source.open(join(dir, 'w.ttl'))).summary('temperature')!.count).toBe(4);

    expect(await times(join(dir, 'w.ttl'))).toEqual(weatherReadings.map((r) => r.time));
  });

  it('allows one writer at a time', async () => {
    const writer = await Source.create(csv());
    await expect(Source.open(join(dir, 'w.ttl'), { write: true })).rejects.toThrow(LockError);
    await writer.close();
    const next = await Source.open(join(dir, 'w.ttl'), { write: true });
    await next.close();
  });

  it('replaces the lock of a process that is gone', async () => {
    const writer = await Source.create(csv());
    await writer.close();
    await writeFile(join(dir, 'w.ttl.lock'), JSON.stringify({ pid: 2 ** 22 - 1 }));
    const next = await Source.open(join(dir, 'w.ttl'), { write: true });
    await next.close();
    await expect(readFile(join(dir, 'w.ttl.lock'))).rejects.toThrow();
  });

  it('refuses an immutable source and a Parquet file', async () => {
    const csvSource = await Source.create(csv());
    await csvSource.append(weatherReadings);
    await csvSource.close({ freeze: true });
    await expect(Source.open(join(dir, 'w.ttl'), { write: true })).rejects.toThrow(NotWritableError);
    const closed = await Source.open(join(dir, 'w.ttl'));
    expect(closed.metadata.immutable).toBe(true);

    const parquet = await Source.create({ ...weatherOptions('Parquet', 'p'), dataFile: join(dir, 'p.parquet'), file: join(dir, 'p.ttl') });
    await parquet.append(weatherReadings);
    await parquet.close();
    expect((await Source.open(join(dir, 'p.ttl'))).metadata.immutable).toBe(true);
    await expect(Source.open(join(dir, 'p.ttl'), { write: true })).rejects.toThrow(NotWritableError);
  });

  it('cannot append to a source that was frozen', async () => {
    const source = await Source.create(csv());
    await source.close({ freeze: true });
    await expect(source.append(weatherReadings[0])).rejects.toThrow(NotWritableError);
  });

  it('releases the lock on close, also when called twice', async () => {
    const source = await Source.create(csv());
    await source.close();
    await source.close();
    await expect(readFile(join(dir, 'w.ttl.lock'))).rejects.toThrow();
  });
});

describe('every format keeps appending', () => {
  for (const [kind, ext] of [['CSV', 'csv'], ['Arrow', 'arrows'], ['EmbeddedRDF', ''], ['EmbeddedJSON', '']] as const) {
    it(`${kind}: batches added across sessions are all read`, async () => {
      const options = { ...weatherOptions(kind, kind), dataFile: ext ? join(dir, `a.${ext}`) : undefined, file: join(dir, `${kind}.ttl`) };
      const one = await Source.create(options);
      await one.append(weatherReadings.slice(0, 2));
      await one.close();
      const two = await Source.open(join(dir, `${kind}.ttl`), { write: true });
      await two.append(weatherReadings.slice(2, 3));
      await two.close();
      const three = await Source.open(join(dir, `${kind}.ttl`), { write: true });
      await three.append(weatherReadings.slice(3));
      await three.close({ freeze: true });
      const readings = await all((await Source.open(join(dir, `${kind}.ttl`))).read());
      expect(readings.map((r) => r.get('temperature')?.value)).toEqual(['8.4', '8.6', '8.5', '9']);
      expect((await (await Source.open(join(dir, `${kind}.ttl`))).validate()).results).toEqual([]);
    });
  }

  it('Arrow: the file is a valid IPC stream that only ends with the end-of-stream marker when the source ends', async () => {
    const source = await Source.create({ ...weatherOptions('Arrow', 'a'), dataFile: join(dir, 'a.arrows') });
    await source.append(weatherReadings.slice(0, 2));
    const EOS = [255, 255, 255, 255, 0, 0, 0, 0];
    const growing = new Uint8Array(await readFile(join(dir, 'a.arrows')));
    expect([...growing.slice(-8)]).not.toEqual(EOS);
    await source.append(weatherReadings.slice(2));
    await source.close({ freeze: true });
    const bytes = new Uint8Array(await readFile(join(dir, 'a.arrows')));
    expect([...bytes.slice(-8)]).toEqual(EOS);
    expect(bytes.length).toBeGreaterThan(growing.length);
    expect([...bytes.slice(0, growing.length)]).toEqual([...growing]);
    const arrow = await import('apache-arrow');
    const table = arrow.tableFromIPC(bytes);
    expect(table.numRows).toBe(4);
    expect(table.schema.fields.map((f) => f.name)).toEqual(['time', 'temp', 'hum', 'status']);
  });

  it('Arrow: reads the IPC file format of an immutable source, but does not write to it', async () => {
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
ex:s a tss:ArrowSource ; tss:immutable true ;
  tss:dataFile <file.arrow> ; tss:timeField ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:Field ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:Field ; tss:columnName "value" ; tss:datatype xsd:double .`,
    );
    const source = await Source.open(join(dir, 'file.ttl'));
    const readings = await all(source.read());
    expect(readings.map((r) => [r.time, r.get('v')?.value])).toEqual([['2026-11-17T12:00:00Z', '1.5'], ['2026-11-17T12:10:00Z', '2.5']]);
    await expect(Source.open(join(dir, 'file.ttl'), { write: true })).rejects.toThrow(NotWritableError);
  });

  it('Parquet: is written when the source is closed, and frozen', async () => {
    const source = await Source.create({ ...weatherOptions('Parquet', 'p'), dataFile: join(dir, 'p.parquet'), file: join(dir, 'p.ttl') });
    await source.append(weatherReadings);
    await source.close();
    expect((await Source.open(join(dir, 'p.ttl'))).summary('temperature')!.count).toBe(4);
    expect(await times(join(dir, 'p.ttl'))).toEqual(weatherReadings.map((r) => r.time));
    expect((await Source.open(join(dir, 'p.ttl'))).metadata.immutable).toBe(true);
  });
});

describe('serializing', () => {
  it('writes the metadata and embedded points in several syntaxes that read back the same', async () => {
    const source = await Source.create(weatherOptions('EmbeddedRDF', 'embedded'));
    await source.append(weatherReadings);
    for (const mediaType of ['text/turtle', 'application/trig', 'application/n-triples', 'application/n-quads', 'application/ld+json']) {
      const text = await source.serialize(mediaType);
      // the default field properties of an embedded source are made from the IRI of its document
      const baseIRI = 'https://example.org/embedded';
      const store = await parseRdf(text, { contentType: mediaType, baseIRI });
      const readings = await all((await Source.open(store, { baseIRI })).read());
      expect(readings.map((r) => r.get('temperature')?.value), mediaType).toEqual(['8.4', '8.6', '8.5', '9']);
    }
  });

  it('works without a metadata file: the data file is referred to relative to it', async () => {
    const source = await Source.create({ ...weatherOptions('CSV', 'solo'), dataFile: join(dir, 'solo.csv') });
    await source.append(weatherReadings);
    const turtle = await source.serialize();
    expect(turtle).toContain('<solo.csv>');
    await source.close();
    await writeFile(join(dir, 'solo.ttl'), turtle);
    expect(await times(join(dir, 'solo.ttl'))).toHaveLength(4);
  });

  it('puts the metadata file in another directory and refers to the data file relative to it', async () => {
    await mkdir(join(dir, 'meta'));
    const source = await Source.create({ ...weatherOptions('CSV', 'far'), dataFile: join(dir, 'data', 'far.csv'), file: join(dir, 'meta', 'far.ttl') });
    await source.append(weatherReadings);
    await source.close();
    expect(await readFile(join(dir, 'meta', 'far.ttl'), 'utf8')).toContain('<../data/far.csv>');
    expect(await times(join(dir, 'meta', 'far.ttl'))).toHaveLength(4);
    expect(ex).toBeTruthy();
  });
});
