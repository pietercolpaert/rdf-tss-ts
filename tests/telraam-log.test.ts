import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Source, type Row } from '../src/index.js';
import { convertLog, observationsOf, openLog } from '../scripts/telraam-log.js';
import { MessageParser } from 'n3.js-messages';
import { tempDir } from './helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

const L = 'https://telraam.net/en/location/';
const IMPL = 'https://implementatie.data.vlaanderen.be/ns/vsds-verkeersmetingen#';
const VERKEER = 'https://data.vlaanderen.be/ns/verkeersmetingen#';
const CL = 'https://data.vlaanderen.be/doc/concept/';
let counter = 0;

/** One message of the Telraam log, with the shape of the real one: a count or a V85 speed in km/h. */
function message(location: string, series: string, time: string, value: number): string {
  const subject = `<${L}${location}#${series}#${time}>`;
  const n = `_:b${counter++}`;
  const common = `${subject} <${VERKEER}geobserveerdObject> <${L}${location}> .
${subject} <http://purl.org/dc/terms/isVersionOf> <${L}${location}#${series}> .
${subject} <http://www.w3.org/ns/prov#generatedAtTime> "${time}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
`;
  if (series === 'v85') {
    return `${common}${subject} <${IMPL}Verkeerssnelheidsmeting.geobserveerdKenmerk> ${n}k .
${subject} <http://def.isotc211.org/iso19156/2011/Observation#OM_Observation.result> ${n}r .
${n}k <${VERKEER}meetrichting> <https://inspire.ec.europa.eu/codelist/LinkDirectionValue/bothDirections> .
${n}k <${VERKEER}voertuigType> <${CL}VkmVoertuigType/auto> .
${n}r <https://schema.org/unitCode> "km/h"^^<https://w3id.org/cdt/ucumunit> .
${n}r <https://schema.org/value> "${value}"^^<http://www.w3.org/2001/XMLSchema#double> .
`;
  }
  const direction = series.endsWith('lft') ? 'outDirection' : 'inDirection';
  return `${common}${subject} <${IMPL}Verkeerstelling.tellingresultaat> "${value}"^^<http://www.w3.org/2001/XMLSchema#integer> .
${subject} <${IMPL}Verkeerstelling.geobserveerdKenmerk> ${n}k .
${n}k <${VERKEER}voertuigType> <${CL}VkmVoertuigType/auto> .
${n}k <${IMPL}Verkeerstellingkenmerk.rijrichting> <https://inspire.ec.europa.eu/codelist/LinkDirectionValue/${direction}> .
`;
}

/** Three days of hourly measurements at two locations, with the late arrival of one hour. */
function log(): string {
  const parts: string[] = [];
  const times: string[] = [];
  for (let h = 0; h < 72; h++) times.push(new Date(Date.UTC(2026, 0, 7) + h * 3_600_000).toISOString().replace('.000Z', '+00:00'));
  for (const time of times) {
    for (const location of ['9000000001', '9000000002']) {
      const h = Date.parse(time) / 3_600_000;
      // like the real log: one message per location and hour, with a node per series
      parts.push(message(location, 'car-lft', time, h % 7) + message(location, 'car-rgt', time, h % 5) + message(location, 'v85', time, 30 + (h % 10) / 2));
    }
  }
  // a measurement that arrives late: the log is not strictly ordered
  parts.push(message('9000000001', 'car-lft', '2026-01-06T23:00:00+00:00', 4));
  return `VERSION "1.1-messages"\n${parts.join('MESSAGE\n')}`;
}

async function all(it: AsyncIterable<Row>): Promise<Row[]> {
  const out: Row[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe('the Telraam message log', () => {
  it('reads the measurements out of a message', () => {
    const [parsed] = new MessageParser({ format: 'TriG', messages: true }).parse(
      `${message('9000000001', 'car-lft', '2026-01-07T08:00:00+00:00', 3)}${message('9000000001', 'car-rgt', '2026-01-07T08:00:00+00:00', 5)}${message('9000000001', 'v85', '2026-01-07T08:00:00+00:00', 31.5)}`,
    );
    const [counted, , speed] = observationsOf(parsed);
    expect(observationsOf(parsed)).toHaveLength(3);
    expect(counted).toMatchObject({ location: `${L}9000000001`, series: 'car-lft', time: '2026-01-07T08:00:00Z', value: '3', kind: 'count' });
    expect(speed).toMatchObject({ series: 'v85', value: '31.5', kind: 'speed', unit: 'http://qudt.org/vocab/unit/KiloM-PER-HR' });
  });

  it('turns the log into a source per location and format, with a column for the speed in km/h', async () => {
    const path = join(dir, 'log.trig.gz');
    await writeFile(path, gzipSync(log()));
    const result = await convertLog(path, { out: dir, kinds: ['Parquet', 'Arrow', 'CSV'], locations: ['9000000001'] });
    expect(result.messages).toBe(72 * 2 + 1);
    expect(result.files.map((f) => [f.id, f.kind, f.readings])).toEqual([
      ['9000000001', 'Parquet', 73],
      ['9000000001', 'Arrow', 73],
      ['9000000001', 'CSV', 73],
    ]);
    for (const name of ['9000000001', '9000000001-arrow', '9000000001-csv']) {
      const source = await Source.open(join(dir, `${name}.ttl`));
      expect(source.metadata.immutable).toBe(true);
      const readings = await all(source.read());
      expect(readings).toHaveLength(73);
      // sorted by time, although the last measurement of the log was late
      expect(readings[0].time).toBe('2026-01-06T23:00:00Z');
      expect(readings[0].get('car-lft')?.value).toBe('4');
      expect(readings[0].get('v85')).toBeUndefined();
      expect(readings[1].get('v85')?.value).toBe('30');
      expect(source.summary('v85')).toMatchObject({ count: 72, missing: 1 });
      expect((await source.validate()).results).toEqual([]);
    }
  });

  it('converts the speed from km/h to m/s while reading', async () => {
    await writeFile(join(dir, 'log.trig'), log());
    await convertLog(join(dir, 'log.trig'), { out: dir, kinds: ['Arrow'], locations: ['9000000002'] });
    const source = await Source.open(join(dir, '9000000002.ttl'));
    const [reading] = await all(source.read({ fields: ['v85'], unit: 'http://qudt.org/vocab/unit/M-PER-SEC' }));
    // 30 km/h is 8.3333... m/s
    expect(reading.get('v85')).toMatchObject({ unit: 'http://qudt.org/vocab/unit/M-PER-SEC' });
    expect(Number(reading.get('v85')!.value)).toBeCloseTo(30 / 3.6, 6);
  });

  it('writes an extrapolated count as a double instead of refusing it', async () => {
    const text = `VERSION "1.1-messages"\n${message('9000000003', 'car-lft', '2026-01-07T08:00:00+00:00', 3.169014084507042)}MESSAGE\n${message('9000000003', 'car-rgt', '2026-01-07T08:00:00+00:00', 2)}`;
    await writeFile(join(dir, 'x.trig'), text);
    await convertLog(join(dir, 'x.trig'), { out: dir, kinds: ['CSV'], locations: ['9000000003'] });
    const source = await Source.open(join(dir, '9000000003.ttl'));
    expect(source.metadata.fields.find((f) => f.localName === 'car-lft')!.datatype).toBe('http://www.w3.org/2001/XMLSchema#double');
    expect(source.metadata.fields.find((f) => f.localName === 'car-rgt')!.datatype).toBe('http://www.w3.org/2001/XMLSchema#integer');
    const [reading] = await all(source.read());
    expect(reading.get('car-lft')?.value).toBe('3.169014084507042');
  });

  it('keeps what it collected in a cache, so the log is not parsed twice', async () => {
    await writeFile(join(dir, 'c.trig'), log());
    const cache = join(dir, 'cache.json');
    const first = await convertLog(join(dir, 'c.trig'), { out: join(dir, 'one'), kinds: ['CSV'], locations: ['9000000002'], cache });
    const second = await convertLog(join(dir, 'does-not-exist.trig'), { out: join(dir, 'two'), kinds: ['CSV'], locations: ['9000000002'], cache });
    expect(second.files.map((f) => f.readings)).toEqual(first.files.map((f) => f.readings));
  });

  it('keeps the first locations of the log, and only the period that is asked for', async () => {
    const path = join(dir, 'log.trig');
    await writeFile(path, log());
    const result = await convertLog(createReadStream(path), { out: dir, kinds: ['CSV'], first: 1, from: '2026-01-08T00:00:00Z', until: '2026-01-09T00:00:00Z' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ id: '9000000001', readings: 24, from: '2026-01-08T00:00:00Z', until: '2026-01-09T00:00:00Z' });
  });

  it('reads a gzipped log and a plain one the same way', async () => {
    await writeFile(join(dir, 'a.trig'), 'VERSION "1.1-messages"\n');
    await writeFile(join(dir, 'a.trig.gz'), gzipSync('VERSION "1.1-messages"\n'));
    for (const name of ['a.trig', 'a.trig.gz']) {
      const chunks: Buffer[] = [];
      for await (const chunk of await openLog(join(dir, name))) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('VERSION "1.1-messages"\n');
    }
  });
});
