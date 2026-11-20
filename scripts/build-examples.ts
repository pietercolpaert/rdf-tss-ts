/**
 * Writes the example sources of the playground, with the library's own writer:
 *
 *   - a weather day in every format (embedded RDF, embedded JSON, CSV, Arrow, Parquet),
 *   - a time grid, written by hand because the writer states each time,
 *   - three locations of the Telraam LDES, and how much smaller they are than the LDES,
 *   - months of Telraam counts and speeds, if examples/telraam-months/ exists,
 *   - monthly gold prices since 1833: a description of a CSV file published elsewhere,
 *   - 41 more time series of the core datasets on GitHub, described by scripts/datahub.ts into
 *     examples/datahub/.
 *
 *   npm run examples [outputDirectory]     (default: _site/examples)
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Source, type CreateOptions, type RowInput, type SourceKind } from '../src/index.js';
import { convertLocation, ldesSize, readMembers, sourceSize, type Member } from './telraam.js';
import { DATAHUB_GROUPS, type DatahubExample } from './datahub.js';
import { EUROSTAT, type EurostatExample } from './eurostat.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, '_site', 'examples'));

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const UNIT = 'http://qudt.org/vocab/unit/';
const QK = 'http://qudt.org/vocab/quantitykind/';
const ex = 'https://example.org/ghent/';
const day = '2026-11-17';

export interface Example {
  id: string;
  title: string;
  group: string;
  description: string;
  /** Path of the metadata document, relative to the examples directory. */
  metadata: string;
  kind: SourceKind | 'CSV (time grid)';
  /** Files of the example with their size in bytes, for display. */
  files?: string[];
  /** The data file is read from another site. */
  remote?: boolean;
  /**
   * The place of the example in the menu of the playground: a publisher, a dataset, and for a
   * dataset of several series, the series. Set at the end, from the group when not given.
   */
  path?: string[];
}

/** Hourly readings of a day in Ghent: made up, but smooth and deterministic. */
function weatherReadings(): RowInput[] {
  const readings: RowInput[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const phase = ((hour - 9) / 24) * 2 * Math.PI;
    readings.push({
      time: `${day}T${String(hour).padStart(2, '0')}:00:00Z`,
      values: {
        temperature: (8 + 5 * Math.sin(phase)).toFixed(1),
        humidity: (72 - 14 * Math.sin(phase)).toFixed(0),
        windspeed: (14 + 7 * Math.cos(phase * 2)).toFixed(1),
        pressure: (101.3 + 0.4 * Math.sin(phase / 2)).toFixed(2),
      },
    });
  }
  return readings;
}

function weatherOptions(kind: CreateOptions['kind'], name: string, extension?: string): CreateOptions {
  return {
    id: `${ex}${name}`,
    kind,
    label: `Weather in Ghent, ${day}`,
    dataFile: extension ? join(out, `${name}.${extension}`) : undefined,
    file: join(out, `${name}.ttl`),
    from: `${day}T00:00:00Z`,
    until: '2026-11-18T00:00:00Z',
    timeField: { id: `${ex}fields/time`, columnName: 'time' },
    prefixes: { ex, qk: QK, unit: UNIT },
    fields: [
      { id: `${ex}fields/temperature`, label: 'Air temperature', columnName: 'temp', datatype: `${XSD}double`, observedProperty: `${QK}Temperature`, unit: `${UNIT}DEG_C`, sensor: `${ex}sensors/thermometer`, featureOfInterest: `${ex}outside-air` },
      { id: `${ex}fields/humidity`, label: 'Relative humidity', columnName: 'hum', datatype: `${XSD}integer`, observedProperty: `${QK}RelativeHumidity`, unit: `${UNIT}PERCENT`, sensor: `${ex}sensors/hygrometer`, featureOfInterest: `${ex}outside-air` },
      { id: `${ex}fields/windspeed`, label: 'Wind speed', columnName: 'wind', datatype: `${XSD}double`, observedProperty: `${QK}Speed`, unit: `${UNIT}KiloM-PER-HR`, sensor: `${ex}sensors/anemometer`, featureOfInterest: `${ex}outside-air` },
      { id: `${ex}fields/pressure`, label: 'Air pressure', columnName: 'press', datatype: `${XSD}double`, observedProperty: `${QK}AtmosphericPressure`, unit: `${UNIT}KiloPA`, sensor: `${ex}sensors/barometer`, featureOfInterest: `${ex}outside-air` },
    ],
  };
}

async function weather(kind: CreateOptions['kind'], name: string, extension?: string): Promise<void> {
  const source = await Source.create(weatherOptions(kind, name, extension));
  await source.append(weatherReadings());
  await source.close({ freeze: true });
}

/** A time grid: the hours are steps from a base, so the file has no times. */
async function timeGrid(): Promise<void> {
  const readings = weatherReadings();
  const rows = readings.map((r, step) => `${step},${r.values.temperature},${r.values.humidity}`);
  await writeFile(join(out, 'weather-grid.csv'), `step,temp,hum\n${rows.join('\n')}\n`);
  await writeFile(
    join(out, 'weather-grid.ttl'),
    `@prefix tss: <https://w3id.org/tss#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix qk: <${QK}> .
@prefix unit: <${UNIT}> .
@prefix ex: <${ex}> .

# The times of the rows are not in the file: row n is at timeBase + n × timeStep.
ex:weather-grid a tss:CSVSource ;
    rdfs:label "Weather in Ghent, ${day}, on a time grid" ;
    tss:immutable true ;
    tss:from "${day}T00:00:00Z"^^xsd:dateTime ;
    tss:until "2026-11-18T00:00:00Z"^^xsd:dateTime ;
    tss:dataFile <weather-grid.csv> ;
    tss:timeBase "${day}T00:00:00Z"^^xsd:dateTime ;
    tss:timeStep "PT1H"^^xsd:duration ;
    tss:timeField ex:time ;
    tss:stepField ex:step ;
    tss:hasField ex:time, ex:step, ex:temperature, ex:humidity .

ex:time a tss:ContextField ; tss:datatype xsd:dateTime .
ex:step a tss:ContextField ; tss:columnName "step" ; tss:datatype xsd:integer .
ex:temperature a tss:ValueField ; rdfs:label "Air temperature" ; tss:columnName "temp" ; tss:datatype xsd:double ;
    tss:observedProperty qk:Temperature ; tss:unit unit:DEG_C .
ex:humidity a tss:ValueField ; rdfs:label "Relative humidity" ; tss:columnName "hum" ; tss:datatype xsd:integer ;
    tss:observedProperty qk:RelativeHumidity ; tss:unit unit:PERCENT .
`,
  );
}

const TELRAAM_DAY = 'Telraam LDES, one day, compared with the LDES';
const TELRAAM_MONTHS = 'Traffic: months of Telraam counts and speeds';
const examples: Example[] = [];
const add = (example: Example) => examples.push(example);

async function telraam(): Promise<void> {
  const directory = join(out, 'telraam');
  await mkdir(directory, { recursive: true });
  const members = await readMembers(join(root, 'examples', 'telraam', 'members.ttl'));
  const locations = [...new Set(members.map((m) => m.location))].sort();
  const ldesTotal = await ldesSize(members);

  const report = [];
  for (const location of locations) {
    const id = location.split('/').pop()!;
    const own: Member[] = members.filter((m) => m.location === location);
    const ldes = await ldesSize(own);
    const sizes: Record<string, Awaited<ReturnType<typeof sourceSize>>> = {};
    for (const [kind, suffix] of [['CSV', ''], ['Parquet', '-parquet'], ['Arrow', '-arrow']] as const) {
      const conversion = await convertLocation(members, location, { dir: directory, kind, name: `${id}${suffix}`, day });
      sizes[kind] = await sourceSize(conversion);
    }
    report.push({ id, location, series: 8, hours: 24, ldes, source: sizes });
    add({
      id: `telraam-${id}`,
      title: `Telraam ${id}`,
      group: TELRAAM_DAY,
      description: `Hourly traffic counts of one Telraam location on ${day}: ${own.length} LDES members become one table of 24 rows and 8 columns.`,
      metadata: `telraam/${id}.ttl`,
      kind: 'CSV',
    });
  }
  const first = locations[0].split('/').pop()!;
  add({ id: `telraam-${first}-parquet`, title: `Telraam ${first} (Parquet)`, group: TELRAAM_DAY, description: 'The same counts in a Parquet file.', metadata: `telraam/${first}-parquet.ttl`, kind: 'Parquet' });
  add({ id: `telraam-${first}-arrow`, title: `Telraam ${first} (Arrow)`, group: TELRAAM_DAY, description: 'The same counts as an Arrow IPC stream.', metadata: `telraam/${first}-arrow.ttl`, kind: 'Arrow' });

  const sample = members.filter((m) => m.location === locations[0] && m.time.startsWith(`${day}T08`)).slice(0, 2);
  const { Writer } = await import('n3');
  const writer = new Writer({ prefixes: (await import('./telraam.js')).PREFIXES });
  for (const m of sample) for (const q of m.quads) writer.addQuad(q);
  const sampleTurtle = await new Promise<string>((resolveSample, reject) => writer.end((e, r) => (e ? reject(e) : resolveSample(r as string))));
  await writeFile(join(directory, 'sample-members.ttl'), sampleTurtle);
  await cp(join(root, 'examples', 'telraam', 'members.ttl'), join(directory, 'ldes-members.ttl'));
  await writeFile(
    join(directory, 'compaction.json'),
    JSON.stringify({ day, source: 'https://ldes.telraam-api.net/measurements', members: members.length, ldes: ldesTotal, locations: report }, null, 2),
  );
}


interface MonthsEntry {
  id: string;
  kind: 'Parquet' | 'Arrow' | 'CSV';
  metadata: string;
  readings: number;
  from: string;
  until: string;
  series: string[];
}

const GOLD = DATAHUB_GROUPS[0];

/** Time series of Eurostat, described by scripts/eurostat.ts. */
async function eurostat(): Promise<void> {
  const source = join(root, 'examples', 'eurostat');
  if (!existsSync(join(source, 'manifest.json'))) return;
  await cp(source, join(out, 'eurostat'), { recursive: true });
  const entries: EurostatExample[] = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  for (const entry of entries) add({ ...entry, group: EUROSTAT, metadata: `eurostat/${entry.metadata}`, kind: 'CSV (time grid)', remote: true });
}

/**
 * Monthly gold prices since 1833: only the description is published here, the CSV file is read
 * from the gold-prices data package on GitHub. A time grid of one month without a step field.
 */
async function gold(): Promise<void> {
  await cp(join(root, 'examples', 'gold-prices'), join(out, 'gold-prices'), { recursive: true });
  add({
    id: 'gold-prices',
    title: 'Monthly gold prices (USD per troy ounce)',
    group: GOLD,
    description:
      'A description of a CSV file that someone else publishes: the gold-prices data package on GitHub. The file has one row per month and no time column the specification can use, so the time of a row is its position on a time grid of one month from 1833-01-01.',
    metadata: 'gold-prices/monthly.ttl',
    kind: 'CSV (time grid)',
    remote: true,
  });
}

/** Time series of the core datasets on GitHub, described by scripts/datahub.ts. */
async function datahub(): Promise<void> {
  const source = join(root, 'examples', 'datahub');
  if (!existsSync(join(source, 'manifest.json'))) return;
  await cp(source, join(out, 'datahub'), { recursive: true });
  const entries: DatahubExample[] = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  for (const entry of entries) add({ ...entry, metadata: `datahub/${entry.metadata}`, kind: 'CSV (time grid)', remote: true });
}

/**
 * Months of Telraam counts and V85 speeds per location, made from the compressed RDF Message
 * Log of Telraam by `scripts/telraam-log.ts` into examples/telraam-months/ (the log is 1.6 GB).
 */
async function telraamMonths(): Promise<void> {
  const source = join(root, 'examples', 'telraam-months');
  if (!existsSync(join(source, 'manifest.json'))) return;
  const entries: MonthsEntry[] = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const directory = join(out, 'telraam-months');
  await cp(source, directory, { recursive: true });
  const first = entries[0].id;
  for (const entry of entries) {
    if (entry.kind !== 'Parquet' && entry.id !== first) continue;
    const days = Math.round((Date.parse(entry.until) - Date.parse(entry.from)) / 86_400_000);
    const speed = entry.series.includes('v85') ? ' and the V85 speed in km/h (convert it to m/s or mph)' : '';
    add({
      id: `telraam-months-${entry.id}${entry.kind === 'Parquet' ? '' : `-${entry.kind.toLowerCase()}`}`,
      title: `Location ${entry.id}${entry.kind === 'Parquet' ? '' : ` (${entry.kind})`}`,
      group: TELRAAM_MONTHS,
      description: `${days} days, ${entry.readings} hourly rows: the counts per vehicle type and direction${speed}, from ${entry.from.slice(0, 10)} to ${entry.until.slice(0, 10)}. ${entry.kind === 'Parquet' ? 'A Parquet file: compact, typed columns.' : entry.kind === 'Arrow' ? 'An Arrow IPC stream.' : 'A CSV file.'}`,
      metadata: `telraam-months/${entry.metadata}`,
      kind: entry.kind,
    });
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await weather('EmbeddedRDF', 'weather-embedded');
await weather('EmbeddedJSON', 'weather-json');
await weather('CSV', 'weather-csv', 'csv');
await weather('Arrow', 'weather-arrow', 'arrows');
await weather('Parquet', 'weather-parquet', 'parquet');
await timeGrid();

const group = 'Weather, one day, in every format';
add({ id: 'weather-embedded', title: 'Embedded RDF', group, description: 'The points are RDF nodes in the metadata document: one document, nothing else to fetch.', metadata: 'weather-embedded.ttl', kind: 'EmbeddedRDF' });
add({ id: 'weather-json', title: 'Embedded JSON', group, description: 'The points are one JSON literal in the metadata document.', metadata: 'weather-json.ttl', kind: 'EmbeddedJSON' });
add({ id: 'weather-csv', title: 'CSV', group, description: 'The points are in a CSV file, found through tss:dataFile.', metadata: 'weather-csv.ttl', kind: 'CSV' });
add({ id: 'weather-grid', title: 'CSV on a time grid', group, description: 'The times are not in the file: row n is at timeBase + n × timeStep.', metadata: 'weather-grid.ttl', kind: 'CSV (time grid)' });
add({ id: 'weather-arrow', title: 'Arrow', group, description: 'An Arrow IPC stream: a file that can be appended to while it is read.', metadata: 'weather-arrow.ttl', kind: 'Arrow' });
add({ id: 'weather-parquet', title: 'Parquet', group, description: 'A Parquet file: written once, compact, with typed columns.', metadata: 'weather-parquet.ttl', kind: 'Parquet' });
await telraam();
await telraamMonths();
await gold();
await datahub();
await eurostat();

// the menu: a publisher, a dataset and, for a dataset of several series, the series
const TELRAAM = 'Belgium · Telraam';
const GITHUB = 'World · core datasets on GitHub';
const WEATHER = 'Examples · a day of weather, in every format';
for (const e of examples) {
  e.path ??=
    e.group === TELRAAM_MONTHS
      ? [TELRAAM, 'Months of traffic counts and speeds', e.title]
      : e.group === TELRAAM_DAY
        ? [TELRAAM, 'One day, compared with the LDES', e.title]
        : DATAHUB_GROUPS.includes(e.group)
          ? [GITHUB, e.group.replace(/ \(core datasets on GitHub\)$/, ''), e.title]
          : [WEATHER, e.title];
}
// in this order, with the months of Telraam first; within a dataset, as they were added
const order = [TELRAAM, EUROSTAT, GITHUB, WEATHER];
const first = (e: Example) => (e.group === TELRAAM_DAY ? 1 : 0);
examples.sort((a, b) => order.indexOf(a.path![0]) - order.indexOf(b.path![0]) || first(a) - first(b));
await writeFile(join(out, 'index.json'), JSON.stringify(examples, null, 2));
console.log(`wrote ${examples.length} examples to ${out}`);
