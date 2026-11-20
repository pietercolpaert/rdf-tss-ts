/**
 * Describes the hourly weather of stations of GeoSphere Austria (https://data.hub.geosphere.at)
 * as RDF Time Series Sources: per station, the hours of 2025, the last complete year, as CSV from
 * the dataset API of GeoSphere, which answers with a year of a station in about a second, with
 * CORS headers. The weather has seasons: the temperature, the radiation and the sunshine follow
 * the day and the year.
 *
 * The times of the API (2025-01-01T00:00+00:00) have no seconds, so they are no xsd:dateTime: the
 * time of a row is its position on a time grid of an hour from the start of 2025. Only a year with
 * a row for every hour fits, which every station is checked for: it is read with the library,
 * from GeoSphere, and the time of every row has to be the time of the API.
 *
 *   npm run examples:geosphere      (writes examples/geosphere/)
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Source } from '../src/index.js';
import { parseCsv } from '../src/formats/csv.js';
import { datatypeOf } from './datahub.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'examples', 'geosphere');
const API = 'https://dataset.api.hub.geosphere.at/v1/station/historical/klima-v2-1h';
const YEAR = 2025;

/** The stations, by their name in GeoSphere: from the Danube to the Sonnblick. */
const STATIONS = [
  'Wien Hohe Warte',
  'Innsbruck Universität',
  'Salzburg Flughafen',
  'Graz Universität/Heinrichstraße',
  'Klagenfurt Flughafen',
  'Linz Stadt',
  'Bregenz',
  'Eisenstadt Nordost',
  'Patscherkofel',
  'Sonnblick',
];

/** The parameters described, with an English label: GeoSphere describes them in German. */
const PARAMETERS: Record<string, string> = {
  tl: 'Air temperature 2 m above ground',
  rf: 'Relative humidity',
  p: 'Air pressure',
  ff: 'Wind speed',
  rr: 'Precipitation',
  so_h: 'Sunshine duration',
  cglo: 'Global radiation, mean',
};

const UNITS: Record<string, string> = { '°C': 'DEG_C', '%': 'PERCENT', hPa: 'HectoPA', 'm/s': 'M-PER-SEC', mm: 'MilliM', h: 'HR', 'W/m²': 'W-PER-M2' };

interface Metadata {
  stations: { id: number; name: string; state: string; altitude: number; lat: number; lon: number; valid_from: string; is_active: boolean }[];
  parameters: { name: string; long_name: string; description: string; unit: string }[];
}

const literal = (text: string) => JSON.stringify(text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function csvRecords(text: string): Promise<Record<string, string>[]> {
  const rows: string[][] = [];
  async function* one() {
    yield text;
  }
  for await (const row of parseCsv(one())) rows.push(row.cells);
  const [header, ...rest] = rows.filter((r) => r.length > 1);
  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** A time of the API, 2025-01-01T00:00+00:00, as an xsd:dateTime in UTC. */
export function parseApiTime(text: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!m) return null;
  const instant = Date.parse(`${m[1]}:${m[2] ?? '00'}${m[3]}`);
  return Number.isNaN(instant) ? null : new Date(instant).toISOString().replace('.000Z', 'Z');
}

async function describe(station: Metadata['stations'][number], parameters: Map<string, Metadata['parameters'][number]>): Promise<{ turtle: string; times: string[]; url: string } | string> {
  const start = `${YEAR}-01-01T00:00`;
  const end = `${YEAR}-12-31T23:00`;
  const url = `${API}?parameters=${Object.keys(PARAMETERS).join(',')}&station_ids=${station.id}&start=${start}&end=${end}&output_format=csv`;
  let records: Record<string, string>[];
  try {
    records = await csvRecords(await fetchText(url));
  } catch (error) {
    return (error as Error).message;
  }
  const times = records.map((r) => parseApiTime(r.time));
  const bad = times.findIndex((t) => !t);
  if (bad >= 0) return `row ${bad + 1} has no time: ${records[bad].time}`;
  const ms = (times as string[]).map((t) => Date.parse(t));
  if (ms[0] !== Date.parse(`${start}:00Z`)) return `the first row is at ${times[0]}`;
  const gap = ms.findIndex((t, i) => i > 0 && t - ms[i - 1] !== 3_600_000);
  if (gap >= 0) return `the rows are not an hour apart: ${times[gap - 1]}, then ${times[gap]}`;

  const measured = (name: string) => records.some((r) => r[name] !== '' && r[name] !== undefined);
  const names = Object.keys(PARAMETERS).filter(measured);
  if (names.length === 0) return 'no parameter is measured';
  const definitions = names.map((name) => {
    const parameter = parameters.get(name)!;
    const unit = UNITS[parameter.unit];
    const statements = [
      'a tss:ValueField',
      `rdfs:label ${literal(PARAMETERS[name])}@en, ${literal(parameter.long_name)}@de`,
      `rdfs:comment ${literal(parameter.description)}@de`,
      `tss:columnName ${literal(name)}`,
      `tss:datatype ${datatypeOf(records.map((r) => r[name])) ?? 'xsd:decimal'}`,
      ...(unit ? [`tss:unit unit:${unit}`] : []),
    ];
    return `<#${name}>\n${statements.map((s) => `    ${s}`).join(' ;\n')} .`;
  });
  const base = `${YEAR}-01-01T00:00:00Z`;
  const turtle = `@prefix tss: <https://w3id.org/tss#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix unit: <http://qudt.org/vocab/unit/> .

# The hourly weather of ${YEAR} at ${station.name} (${station.state}, ${Math.round(station.altitude)} m), from the
# dataset klima-v2-1h of GeoSphere Austria, as CSV from its dataset API. This document only
# describes it. Written by scripts/geosphere.ts.
#
# The times of the API have no seconds, so they are no xsd:dateTime: the file has one row per
# hour, without gaps, so the time of a row is its step on a time grid of PT1H from ${base}.
<#source>
    a tss:CSVSource ;
    rdfs:label ${literal(`Hourly weather of ${YEAR}, ${station.name}`)}@en ;
    rdfs:comment ${literal(`Measurements of the weather station ${station.name} of GeoSphere Austria, at ${Math.round(station.altitude)} m above sea level, one row per hour of ${YEAR}.`)}@en ;
    dcterms:publisher <https://www.geosphere.at> ;
    dcterms:source <https://data.hub.geosphere.at/dataset/klima-v2-1h> ;
    dcterms:license <https://creativecommons.org/licenses/by/4.0/> ;
    tss:immutable true ;
    tss:from ${literal(base)}^^xsd:dateTime ;
    tss:until ${literal(`${YEAR + 1}-01-01T00:00:00Z`)}^^xsd:dateTime ;
    tss:dataFile <${url}> ;
    tss:timeBase ${literal(base)}^^xsd:dateTime ;
    tss:timeStep "PT1H"^^xsd:duration ;
    tss:timeField <#hour> ;
    tss:hasField <#hour>,
        <#time>,
        ${names.map((n) => `<#${n}>`).join(',\n        ')} .

# The time field: computed from the position of the row, so it has no column.
<#hour>
    a tss:ContextField ;
    rdfs:label "Time"@en ;
    tss:datatype xsd:dateTime .

<#time>
    a tss:ContextField ;
    rdfs:label "Time as written by the API"@en ;
    rdfs:comment "The start of the hour, such as 2025-01-01T00:00+00:00: without seconds, so not an xsd:dateTime, and not the time of the row."@en ;
    tss:columnName "time" ;
    tss:datatype xsd:string .

${definitions.join('\n\n')}
`;
  return { turtle, times: times as string[], url };
}

async function check(file: string, times: string[]): Promise<void> {
  const source = await Source.open(file);
  const report = await source.validate();
  if (!report.conforms) throw new Error(`${file} does not conform: ${JSON.stringify(report.results.slice(0, 3))}`);
  let i = 0;
  for await (const row of source.read()) {
    if (row.time !== times[i]) throw new Error(`${file}: row ${i + 1} is at ${row.time}, the API says ${times[i]}`);
    i++;
  }
  if (i !== times.length) throw new Error(`${file}: ${i} rows read, the API gave ${times.length}`);
}

export interface GeoSphereExample {
  id: string;
  title: string;
  path: [string, string, string];
  description: string;
  metadata: string;
}

export const GEOSPHERE = 'Austria · GeoSphere';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await rm(out, { recursive: true, force: true });
  const metadata = JSON.parse(await fetchText(`${API}/metadata`)) as Metadata;
  const parameters = new Map(metadata.parameters.map((p) => [p.name, p]));
  const manifest: GeoSphereExample[] = [];
  const skipped: string[] = [];
  for (const name of STATIONS) {
    // of the stations of a name, the active one with the highest id: the automatic station
    const station = metadata.stations.filter((s) => s.name === name && s.is_active).sort((a, b) => b.id - a.id)[0];
    if (!station) {
      skipped.push(`${name}: no active station`);
      continue;
    }
    await sleep(300);
    const described = await describe(station, parameters);
    if (typeof described === 'string') {
      skipped.push(`${name} (${station.id}): ${described}`);
      continue;
    }
    const slug = name.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const file = `${slug}.ttl`;
    await mkdir(out, { recursive: true });
    await writeFile(join(out, file), described.turtle);
    await sleep(300);
    await check(join(out, file), described.times);
    manifest.push({
      id: `geosphere-${slug}`,
      title: `Hourly weather of ${YEAR}, ${name}`,
      path: [GEOSPHERE, `Hourly weather of ${YEAR}`, `${name} (${Math.round(station.altitude)} m)`],
      description: `The ${described.times.length} hours of ${YEAR} at the weather station ${name} (${station.state}) of GeoSphere Austria, read from its dataset API as CSV. The times of the API have no seconds, so they are no xsd:dateTime: the time of a row is its position on a time grid of an hour. The weather has seasons: see the patterns tab.`,
      metadata: file,
    });
    console.log(`ok ${file.padEnd(40)} station ${station.id}, ${described.times.length} rows`);
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const line of skipped) console.log(`skipped ${line}`);
  console.log(`described ${manifest.length} series in ${out}, skipped ${skipped.length}`);
}
