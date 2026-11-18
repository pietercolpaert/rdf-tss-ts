/**
 * Turns the Telraam measurements, published as a (compressed) RDF Message Log of TriG, into
 * RDF-TSS snippets in a binary format: one snippet per location, a column per series (the
 * hourly counts per vehicle type and direction, and the V85 speed in km/h), a row per hour.
 *
 *   npx tsx scripts/telraam-log.ts <log.trig[.gz] | https://…> --out <directory>
 *       [--locations 9000006949,9000010177 | --first 6]  [--from <time>] [--until <time>]
 *       [--kind Parquet,Arrow,CSV] [--cache collected.json]
 *
 * The log is read as a stream, one message at a time, with the parser that ldfetch uses for
 * message logs (n3.js-messages): a log of months does not fit in memory as one dataset. Only
 * the selected locations are kept.
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { MessageStreamParser } from 'n3.js-messages';
import { Snippet, type CreateField } from '../src/index.js';
import { PREFIXES } from './telraam.js';

const { namedNode, blankNode, quad } = DataFactory;

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const TSS = 'https://w3id.org/tss#';
const UNIT = 'http://qudt.org/vocab/unit/';
const QK = 'http://qudt.org/vocab/quantitykind/';
const VERKEER = 'https://data.vlaanderen.be/ns/verkeersmetingen#';
const IMPL = 'https://implementatie.data.vlaanderen.be/ns/vsds-verkeersmetingen#';
const TERMS = 'http://purl.org/dc/terms/';
const SCHEMA = 'https://schema.org/';
const OM_RESULT = 'http://def.isotc211.org/iso19156/2011/Observation#OM_Observation.result';
const GENERATED = 'http://www.w3.org/ns/prov#generatedAtTime';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const AANTAL = 'https://data.vlaanderen.be/doc/concept/VkmVerkeersKenmerkType/aantal';
const V85 = 'https://data.vlaanderen.be/doc/concept/VkmVerkeersKenmerkType/V85';
const SENSOR_TYPE = 'https://data.vlaanderen.be/doc/concept/VkmMeetInstrumentType/telraam';

/** UCUM codes of the log, as the QUDT units they are. */
const UCUM: Record<string, string> = { 'km/h': `${UNIT}KiloM-PER-HR`, 'm/s': `${UNIT}M-PER-SEC` };

export interface Observation {
  location: string;
  /** The series within the location, e.g. `car-lft` or `v85`. */
  series: string;
  time: string;
  value: string;
  datatype: string;
  /** QUDT unit of the value, if the message has one. */
  unit?: string;
  kind: 'count' | 'speed';
  vehicleType?: string;
  direction?: string;
}

/**
 * What one message of the log says: the measurements of the series of a location at a time
 * (the real log has a message per location and hour, with a node per series).
 */
export function observationsOf(message: Quad[]): Observation[] {
  const by = new Map<string, Quad[]>();
  for (const q of message) by.set(q.subject.value, [...(by.get(q.subject.value) ?? []), q]);
  const one = (quads: Quad[] | undefined, predicate: string) => quads?.find((q) => q.predicate.value === predicate)?.object;
  const out: Observation[] = [];
  for (const root of new Set(message.filter((q) => q.predicate.value === GENERATED).map((q) => q.subject.value))) {
    const own = by.get(root)!;
    const series = one(own, `${TERMS}isVersionOf`)?.value;
    const location = one(own, `${VERKEER}geobserveerdObject`)?.value;
    const time = one(own, GENERATED)?.value;
    if (!series || !location || !time) continue;
    const base = { location, series: series.split('#')[1], time: time.replace(/\+00:00$/, 'Z') };

    const counted = one(own, `${IMPL}Verkeerstelling.tellingresultaat`);
    if (counted) {
      const kenmerk = by.get(one(own, `${IMPL}Verkeerstelling.geobserveerdKenmerk`)?.value ?? '');
      out.push({
        ...base,
        kind: 'count',
        value: counted.value,
        datatype: counted.termType === 'Literal' ? counted.datatype.value : `${XSD}integer`,
        vehicleType: one(kenmerk, `${VERKEER}voertuigType`)?.value,
        direction: one(kenmerk, `${IMPL}Verkeerstellingkenmerk.rijrichting`)?.value,
      });
      continue;
    }
    const result = by.get(one(own, OM_RESULT)?.value ?? '');
    const value = one(result, `${SCHEMA}value`);
    if (!value) continue;
    const kenmerk = by.get(one(own, `${IMPL}Verkeerssnelheidsmeting.geobserveerdKenmerk`)?.value ?? '');
    const code = one(result, `${SCHEMA}unitCode`)?.value;
    const unit = code ? UCUM[code] : undefined;
    if (code && !unit) throw new Error(`no QUDT unit known for the UCUM code "${code}"`);
    out.push({
      ...base,
      kind: 'speed',
      value: value.value,
      datatype: value.termType === 'Literal' ? value.datatype.value : `${XSD}double`,
      unit,
      vehicleType: one(kenmerk, `${VERKEER}voertuigType`)?.value,
      direction: one(kenmerk, `${VERKEER}meetrichting`)?.value,
    });
  }
  return out;
}

export type LogKind = 'Parquet' | 'Arrow' | 'CSV';

export interface LogOptions {
  /** Directory for the snippets. */
  out: string;
  /** The binary formats to write; the first one has no suffix in its file names, the others `-arrow`, `-csv`, … */
  kinds: LogKind[];
  /** The locations to keep (their number, e.g. `9000006949`). */
  locations?: string[];
  /** Keep the first N locations that report in the first hour of the log. */
  first?: number;
  /** Keep the observations from this time (inclusive) and until this time (exclusive). */
  from?: string;
  until?: string;
  /**
   * A JSON file with what was collected from the log. When it exists the log is not read again,
   * otherwise it is written after reading: a log of months takes a while to parse.
   */
  cache?: string;
  /** Called every so many messages. */
  progress?: (messages: number, time: string) => void;
}

export interface LogResult {
  files: { id: string; location: string; kind: LogKind; metadataFile: string; readings: number; from: string; until: string; series: string[] }[];
  messages: number;
  skipped: number;
}

interface Collected {
  series: Map<string, Observation>;
  rows: Map<string, Record<string, string>>;
}

/** A message log of TriG, gzipped or not, from a file or a URL, as a stream of bytes. */
export async function openLog(source: string): Promise<Readable> {
  let input: Readable;
  if (/^https?:/.test(source)) {
    const response = await fetch(source);
    if (!response.ok || !response.body) throw new Error(`${source}: ${response.status}`);
    input = Readable.fromWeb(response.body as never);
  } else {
    input = createReadStream(source);
  }
  const head: Buffer[] = [];
  // look at the first bytes: gzip starts with 1f 8b
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error(`${source} is empty`);
  head.push(first.value as Buffer);
  const gzipped = head[0][0] === 0x1f && head[0][1] === 0x8b;
  const rest = Readable.from(
    (async function* () {
      yield head[0];
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value as Buffer;
      }
    })(),
  );
  return gzipped ? rest.pipe(createGunzip()) : rest;
}

async function collect(source: string | Readable, options: LogOptions): Promise<{ collected: Map<string, Collected>; messages: number; skipped: number }> {
  const input = typeof source === 'string' ? await openLog(source) : source;
  const wanted = options.locations ? new Set(options.locations.map((l) => l.replace(/^.*\//, ''))) : undefined;
  const chosen = new Set<string>();
  let firstTime: string | undefined;
  const collected = new Map<string, Collected>();
  let messages = 0;
  let skipped = 0;

  const messagesIn = input.pipe(new MessageStreamParser({ format: 'TriG', messages: true }));
  for await (const message of messagesIn as AsyncIterable<Quad[]>) {
    messages++;
    const observations = observationsOf(message);
    if (observations.length === 0) {
      skipped++;
      continue;
    }
    if (messages % 50_000 === 0) options.progress?.(messages, observations[0].time);
    for (const o of observations) {
      if (options.from && o.time < options.from) continue;
      if (options.until && o.time >= options.until) continue;
      const id = o.location.split('/').pop()!;
      if (wanted) {
        if (!wanted.has(id)) continue;
      } else if (options.first !== undefined) {
        firstTime ??= o.time;
        if (o.time === firstTime && chosen.size < options.first) chosen.add(id);
        if (!chosen.has(id)) continue;
      }
      let entry = collected.get(o.location);
      if (!entry) collected.set(o.location, (entry = { series: new Map(), rows: new Map() }));
      if (!entry.series.has(o.series)) entry.series.set(o.series, o);
      const row = entry.rows.get(o.time) ?? {};
      row[o.series] = o.value;
      entry.rows.set(o.time, row);
    }
  }
  return { collected, messages, skipped };
}

export async function convertLog(source: string | Readable, options: LogOptions): Promise<LogResult> {
  await mkdir(options.out, { recursive: true });
  let collected: Map<string, Collected>;
  let messages = 0;
  let skipped = 0;
  if (options.cache && existsSync(options.cache)) {
    const saved = JSON.parse(await readFile(options.cache, 'utf8')) as { messages: number; skipped: number; locations: [string, { series: [string, Observation][]; rows: [string, Record<string, string>][] }][] };
    ({ messages, skipped } = saved);
    collected = new Map(saved.locations.map(([location, c]) => [location, { series: new Map(c.series), rows: new Map(c.rows) }]));
  } else {
    ({ collected, messages, skipped } = await collect(source, options));
    if (options.cache) {
      const locations = [...collected].map(([location, c]) => [location, { series: [...c.series], rows: [...c.rows] }]);
      await writeFile(options.cache, JSON.stringify({ messages, skipped, locations }));
    }
  }

  const files: LogResult['files'] = [];
  for (const [location, entry] of [...collected].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [index, kind] of options.kinds.entries()) files.push(await writeLocation(location, entry, options, kind, index === 0 ? '' : `-${kind.toLowerCase()}`));
  }
  return { files, messages, skipped };
}

const label = (name: string) =>
  name === 'v85' ? 'Speed V85' : name.replace('-lft', ' (left)').replace('-rgt', ' (right)').replace(/^./, (c) => c.toUpperCase());

async function writeLocation(location: string, entry: Collected, options: LogOptions, kind: LogKind, suffix: string) {
  const id = location.split('/').pop()!;
  const names = [...entry.series.keys()].sort();
  const fields: CreateField[] = names.map((name) => {
    const o = entry.series.get(name)!;
    // the counts of Telraam are sometimes extrapolated: integer only when every value is
    const integers = o.datatype === `${XSD}integer` && [...entry.rows.values()].every((row) => row[name] === undefined || /^-?\d+$/.test(row[name]));
    const field: CreateField = {
      id: `${location}#${name}`,
      label: label(name),
      datatype: integers || o.datatype !== `${XSD}integer` ? o.datatype : `${XSD}double`,
      observedProperty: o.kind === 'speed' ? `${QK}Speed` : AANTAL,
      featureOfInterest: location,
      sensor: `${location}#sensor`,
    };
    if (o.unit) field.unit = o.unit;
    return field;
  });
  const times = [...entry.rows.keys()].sort();
  const extension = { CSV: 'csv', Parquet: 'parquet', Arrow: 'arrows' }[kind];
  const name = `${id}${suffix}`;
  const until = new Date(Date.parse(times[times.length - 1]) + 3_600_000).toISOString().replace('.000Z', 'Z');
  const metadataFile = join(options.out, `${name}.ttl`);
  const snippet = await Snippet.create({
    id: `${location}#snippet-${times[0].slice(0, 10)}-${until.slice(0, 10)}`,
    kind,
    label: `Traffic counts and speed at Telraam location ${id}, ${times[0].slice(0, 10)} to ${until.slice(0, 10)}`,
    dataFile: join(options.out, `${name}.${extension}`),
    file: metadataFile,
    from: times[0],
    until,
    timeField: { id: `${location}#time`, columnName: 'time' },
    fields,
    prefixes: { ...PREFIXES, qk: QK, unit: UNIT, schema: SCHEMA },
  });

  // What the log says about each series, kept as a description of its field.
  for (const [seriesName, o] of entry.series) {
    const node = blankNode();
    const field = namedNode(`${location}#${seriesName}`);
    snippet.dataset.add(quad(field, namedNode(`${TSS}fieldDescription`), node));
    if (o.vehicleType) snippet.dataset.add(quad(node, namedNode(`${VERKEER}voertuigType`), namedNode(o.vehicleType)));
    snippet.dataset.add(quad(node, namedNode(`${IMPL}${o.kind === 'speed' ? 'Verkeerssnelheidsmetingkenmerk' : 'Verkeerstellingkenmerk'}.kenmerktype`), namedNode(o.kind === 'speed' ? V85 : AANTAL)));
    if (o.direction) snippet.dataset.add(quad(node, namedNode(o.kind === 'speed' ? `${VERKEER}meetrichting` : `${IMPL}Verkeerstellingkenmerk.rijrichting`), namedNode(o.direction)));
  }
  const sensor = namedNode(`${location}#sensor`);
  snippet.dataset.add(quad(sensor, namedNode(RDF_TYPE), namedNode('http://www.w3.org/ns/sosa/Sensor')));
  snippet.dataset.add(quad(sensor, namedNode(`${TERMS}type`), namedNode(SENSOR_TYPE)));

  await snippet.append(times.map((time) => ({ time, values: entry.rows.get(time)! })));
  await snippet.close({ freeze: true });
  return { id, location, kind, metadataFile, readings: times.length, from: times[0], until, series: names };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const source = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const out = arg(args, 'out');
  if (!source || !out) {
    console.error('usage: telraam-log.ts <log.trig[.gz] | url> --out <directory> [--locations a,b | --first N] [--from t] [--until t] [--kind Parquet,Arrow,CSV] [--cache collected.json]');
    process.exit(2);
  }
  const started = Date.now();
  const result = await convertLog(source, {
    out,
    kinds: (arg(args, 'kind') ?? 'Parquet').split(',') as LogKind[],
    locations: arg(args, 'locations')?.split(','),
    first: arg(args, 'first') ? Number(arg(args, 'first')) : undefined,
    from: arg(args, 'from'),
    until: arg(args, 'until'),
    cache: arg(args, 'cache'),
    progress: (n, time) => console.error(`${n} messages, at ${time}`),
  });
  await writeFile(join(out, 'manifest.json'), JSON.stringify(result.files.map(({ metadataFile, ...f }) => ({ ...f, metadata: metadataFile.split('/').pop() })), null, 2));
  for (const f of result.files) console.log(`${f.id} ${f.kind}: ${f.readings} hours, ${f.from} to ${f.until}, ${f.series.join(' ')}`);
  console.log(`${result.messages} messages (${result.skipped} without a measurement) in ${Math.round((Date.now() - started) / 1000)} s`);
}
