import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Source, toRDFMessages, type Row } from '../src/index.js';
import { convertLocation, ldesSize, readMembers, sourceSize, type Member } from '../scripts/telraam.js';
import { tempDir } from './helpers/fixtures.js';

const SAMPLE = new URL('../examples/telraam/members.ttl', import.meta.url).pathname;
const day = '2026-11-17';

async function all(it: AsyncIterable<Row>): Promise<Row[]> {
  const out: Row[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe('the Telraam LDES as RDF-TSS', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let members: Member[];
  let locations: string[];

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    members = await readMembers(SAMPLE);
    locations = [...new Set(members.map((m) => m.location))];
  });
  afterAll(() => cleanup());

  it('has real members: one count of one series at one location per hour', () => {
    expect(members).toHaveLength(576);
    expect(locations).toHaveLength(3);
    for (const location of locations) {
      const own = members.filter((m) => m.location === location);
      expect(own).toHaveLength(192);
      expect(new Set(own.map((m) => m.series)).size).toBe(8);
      expect(new Set(own.map((m) => m.time)).size).toBe(24);
    }
  });

  it('keeps every count, exactly as the LDES published it', async () => {
    for (const location of locations) {
      const id = location.split('/').pop();
      const conversion = await convertLocation(members, location, { dir, kind: 'CSV', name: `csv-${id}`, day });
      const source = await Source.open(conversion.metadataFile);
      const readings = await all(source.read());
      expect(readings).toHaveLength(24);
      const byTime = new Map(readings.map((r) => [r.time, r]));
      for (const m of members.filter((x) => x.location === location)) {
        expect(byTime.get(m.time)!.get(m.series)!.value, `${m.series} ${m.time}`).toBe(m.value);
      }
      expect((await source.validate()).results).toEqual([]);
    }
  });

  it('keeps the counts in Parquet and Arrow too', async () => {
    const location = locations[0];
    for (const kind of ['Parquet', 'Arrow'] as const) {
      const conversion = await convertLocation(members, location, { dir, kind, name: `${kind}-x`, day });
      const readings = await all((await Source.open(conversion.metadataFile)).read());
      const byTime = new Map(readings.map((r) => [Date.parse(r.time), r]));
      for (const m of members.filter((x) => x.location === location)) {
        expect(byTime.get(Date.parse(m.time))!.get(m.series)!.toNative(), `${kind} ${m.series} ${m.time}`).toBe(Number(m.value));
      }
    }
  });

  it('gives back the observations of the LDES: what, where, when and how much', async () => {
    const location = locations[1];
    const conversion = await convertLocation(members, location, { dir, kind: 'CSV', name: 'obs', day });
    const source = await Source.open(conversion.metadataFile);
    const own = members.filter((m) => m.location === location);
    let count = 0;
    const seen = new Set<string>();
    for await (const message of toRDFMessages(source.read(), { metadata: false, align: 'sosa' })) {
      const text = await message.serialize('application/n-triples');
      for (const quad of message.quads) {
        if (quad.predicate.value.endsWith('hasSimpleResult')) {
          const observation = message.quads.filter((q) => q.subject.value === quad.subject.value);
          const get = (p: string) => observation.find((q) => q.predicate.value.endsWith(p))!.object.value;
          expect(get('hasFeatureOfInterest')).toBe(location);
          expect(get('observedProperty')).toBe('https://data.vlaanderen.be/doc/concept/VkmVerkeersKenmerkType/aantal');
          seen.add(`${get('resultTime')}|${quad.object.value}`);
          count++;
        }
      }
      expect(text).toContain('http://www.w3.org/ns/sosa/Observation');
    }
    expect(count).toBe(own.length);
    for (const m of own) expect(seen.has(`${m.time}|${m.value}`)).toBe(true);
  });

  it('describes each series with what the LDES says about it', async () => {
    const location = locations[2];
    const conversion = await convertLocation(members, location, { dir, kind: 'CSV', name: 'desc', day });
    const source = await Source.open(conversion.metadataFile);
    const turtle = await source.dataset;
    const text = await (await import('../src/index.js')).serializeRdf([...turtle], 'application/n-triples');
    expect(text).toContain('https://data.vlaanderen.be/doc/concept/VkmVoertuigType/fiets');
    expect(text).toContain('https://data.vlaanderen.be/doc/concept/VkmVoertuigType/vrachtwagen');
    expect(text).toContain('LinkDirectionValue/inOppositeDirection');
    expect(source.metadata.fields.map((f) => f.localName)).toEqual(
      expect.arrayContaining(['bike-lft', 'bike-rgt', 'car-lft', 'car-rgt', 'heavy-lft', 'heavy-rgt', 'pedestrian-lft', 'pedestrian-rgt', 'time']),
    );
  });

  it('is much smaller than the LDES', async () => {
    const ldes = await ldesSize(members);
    let sources = { total: 0, gzip: 0 };
    for (const location of locations) {
      const conversion = await convertLocation(members, location, { dir, kind: 'CSV', name: `size-${location.split('/').pop()}`, day });
      const size = await sourceSize(conversion);
      sources = { total: sources.total + size.total, gzip: sources.gzip + size.gzip };
    }
    console.log(`LDES ${ldes.bytes} bytes (${ldes.gzip} gzipped) -> RDF-TSS ${sources.total} bytes (${sources.gzip} gzipped): ${(ldes.bytes / sources.total).toFixed(0)}x smaller, ${(ldes.gzip / sources.gzip).toFixed(0)}x gzipped`);
    expect(ldes.bytes / sources.total).toBeGreaterThan(15);
    expect(ldes.gzip / sources.gzip).toBeGreaterThan(4);
  });

  it('is one source that can be read in a single request, with a stored summary of each series', async () => {
    const join_ = join;
    const conversion = await convertLocation(members, locations[0], { dir, kind: 'CSV', name: 'sum', day });
    const source = await Source.open(join_(dir, 'sum.ttl'));
    const own = members.filter((m) => m.location === locations[0] && m.series.endsWith('#car-lft')).map((m) => Number(m.value));
    expect(source.summary('car-lft')).toMatchObject({ count: 24, missing: 0 });
    expect(Number(source.summary('car-lft')!.mean)).toBeCloseTo(own.reduce((a, b) => a + b, 0) / own.length, 8);
    expect(conversion.series).toHaveLength(8);
  });
});
