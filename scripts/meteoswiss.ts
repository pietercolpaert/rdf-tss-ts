/**
 * Describes the weather of automatic stations of MeteoSwiss (https://www.meteoswiss.admin.ch) as
 * RDF Time Series Sources: per station, the hourly values since 2020 and the daily values since
 * the start of its record, which MeteoSwiss publishes as static CSV files on data.geo.admin.ch,
 * with CORS headers and Range requests. The weather has seasons: the temperature, the humidity,
 * the radiation and the sunshine follow the day and the year.
 *
 * The times of the files (19.11.2026 23:00, in UTC) are no xsd:dateTime, so the time of a row is
 * its position on a time grid of an hour or a day from the first row. Only a file with a row at
 * every step fits, which every file is checked for: it is read with the library, from
 * data.geo.admin.ch, and the time of every row has to be the time in the file.
 *
 * The historical files only grow, a year at a time, from a fixed start. The recent files of the
 * current year (hourly and every ten minutes) start anew on 1 January: a time grid would put the
 * rows of a new year at the times of the last one, so they are left out.
 *
 *   npm run examples:meteoswiss      (writes examples/meteoswiss/)
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Source } from '../src/index.js';
import { parseCsv } from '../src/formats/csv.js';
import { datatypeOf } from './datahub.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'examples', 'meteoswiss');
const BASE = 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn';
const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-smn';

/** From the lowlands to the Jungfraujoch, north and south of the Alps. */
const STATIONS = ['SMA', 'GVE', 'BAS', 'BER', 'LUG', 'SIO', 'DAV', 'SAE', 'JUN', 'OTL'];

interface Series {
  /** The file of a station: `ogd-smn_<station>_<file>.csv`. */
  file: string;
  /** The dataset in the menu of the playground. */
  title: string;
  step: 'PT1H' | 'P1D';
  /** The parameters described, by their MeteoSwiss code. */
  parameters: string[];
  /** The minimum and the maximum of a parameter, which describe its value. */
  ranges: Record<string, [string, string]>;
}

const SERIES: Series[] = [
  {
    file: 'h_historical_2020-2029',
    title: 'Hourly weather since 2020',
    step: 'PT1H',
    parameters: ['tre200h0', 'ure200h0', 'prestah0', 'fkl010h0', 'rre150h0', 'gre000h0', 'sre000h0'],
    ranges: { tre200h0: ['tre200hn', 'tre200hx'] },
  },
  {
    file: 'd_historical',
    title: 'Daily weather, the whole record',
    step: 'P1D',
    parameters: ['tre200d0', 'ure200d0', 'prestad0', 'fkl010d0', 'rre150d0', 'gre000d0', 'sre000d0'],
    ranges: { tre200d0: ['tre200dn', 'tre200dx'] },
  },
];

/** The units of MeteoSwiss, as QUDT units. */
const UNITS: Record<string, string> = { '°C': 'DEG_C', '%': 'PERCENT', hPa: 'HectoPA', 'm/s': 'M-PER-SEC', mm: 'MilliM', 'W/m²': 'W-PER-M2', min: 'MIN', h: 'HR' };

/* ---------- metadata of MeteoSwiss ---------- */

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function csvRecords(text: string): Promise<Record<string, string>[]> {
  const rows: string[][] = [];
  async function* one() {
    yield text;
  }
  for await (const row of parseCsv(one(), ';')) rows.push(row.cells);
  const [header, ...rest] = rows.filter((r) => r.length > 1);
  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** The metadata files of MeteoSwiss are in ISO 8859-1. */
const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

/* ---------- times ---------- */

/** A time of the files, 19.11.2026 23:00 (UTC), as an xsd:dateTime. */
export function parseTimestamp(text: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(text);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00Z` : null;
}

const STEP_MS = { PT1H: 3_600_000, P1D: 86_400_000 };

/* ---------- the descriptions ---------- */

const literal = (text: string) => JSON.stringify(text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Parameter {
  description: string;
  unit: string;
}

interface Station {
  name: string;
  canton: string;
  height: string;
}

async function describe(series: Series, abbr: string, station: Station, parameters: Map<string, Parameter>): Promise<{ turtle: string; times: string[] } | string> {
  const code = abbr.toLowerCase();
  const url = `${BASE}/${code}/ogd-smn_${code}_${series.file}.csv`;
  let records: Record<string, string>[];
  try {
    records = await csvRecords(new TextDecoder().decode(await fetchBytes(url)));
  } catch (error) {
    return (error as Error).message;
  }
  const times = records.map((r) => parseTimestamp(r.reference_timestamp));
  const bad = times.findIndex((t) => !t);
  if (bad >= 0) return `row ${bad + 1} has no time: ${records[bad].reference_timestamp}`;
  const ms = (times as string[]).map((t) => Date.parse(t));
  const gap = ms.findIndex((t, i) => i > 0 && t - ms[i - 1] !== STEP_MS[series.step]);
  if (gap >= 0) return `the rows are not one step apart: ${times[gap - 1]}, then ${times[gap]}`;

  // the parameters this station measures: a column with a value
  const columns = new Set(Object.keys(records[0]));
  const measured = (name: string) => columns.has(name) && records.some((r) => r[name] !== '');
  const fields: string[] = [];
  const definitions: string[] = [];
  const featureOfInterest = `<${STAC}/items/${code}>`;
  const field = (name: string, extra: string[]) => {
    const parameter = parameters.get(name)!;
    const datatype = datatypeOf(records.map((r) => r[name])) ?? 'xsd:decimal';
    const unit = UNITS[parameter.unit];
    const statements = [
      ...extra,
      `rdfs:label ${literal(parameter.description)}@en`,
      `tss:columnName ${literal(name)}`,
      `tss:datatype ${datatype}`,
      ...(unit ? [`tss:unit unit:${unit}`] : []),
    ];
    fields.push(`<#${name}>`);
    definitions.push(`<#${name}>\n${statements.map((s) => `    ${s}`).join(' ;\n')} .`);
  };
  for (const name of series.parameters.filter(measured)) {
    field(name, ['a tss:ValueField', `tss:featureOfInterest ${featureOfInterest}`]);
    // the minimum and the maximum within the hour or the day describe the mean
    const range = series.ranges[name];
    if (range && range.every(measured)) {
      field(range[0], ['a tss:ContextField', `tss:describesField <#${name}>`, 'tss:property schema:minValue']);
      field(range[1], ['a tss:ContextField', `tss:describesField <#${name}>`, 'tss:property schema:maxValue']);
    }
  }
  if (fields.length === 0) return 'no parameter is measured';

  const base = times[0]!;
  const what = series.step === 'PT1H' ? 'hour' : 'day';
  const turtle = `@prefix tss: <https://w3id.org/tss#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix schema: <https://schema.org/> .
@prefix unit: <http://qudt.org/vocab/unit/> .

# The ${what === 'hour' ? 'hourly' : 'daily'} weather at ${station.name} (${station.canton}, ${station.height} m), from the
# automatic weather stations of MeteoSwiss: ${series.file} of the station, a static CSV file on
# data.geo.admin.ch. This document only describes it. Written by scripts/meteoswiss.ts.
#
# The file has one row per ${what}, without gaps, so the time of a row is its step on a time grid of
# ${series.step} from ${base}: the reference_timestamp column (in UTC) is not read as the time. A
# year of rows is added to the file every January.
<#source>
    a tss:CSVSource ;
    rdfs:label ${literal(`${series.title.replace(/,.*$/, '')}, ${station.name}`)}@en ;
    rdfs:comment ${literal(`Measurements of the automatic weather station ${station.name} of MeteoSwiss, at ${station.height} m above sea level, one row per ${what}.`)}@en ;
    dcterms:publisher <https://www.meteoswiss.admin.ch> ;
    dcterms:source <${STAC}> ;
    dcterms:license <https://creativecommons.org/licenses/by/4.0/> ;
    tss:from ${literal(base)}^^xsd:dateTime ;
    tss:dataFile <${url}> ;
    tss:delimiter ";" ;
    tss:timeBase ${literal(base)}^^xsd:dateTime ;
    tss:timeStep ${literal(series.step)}^^xsd:duration ;
    tss:timeField <#time> ;
    tss:hasField <#time>,
        <#reference_timestamp>,
        ${fields.join(',\n        ')} .

# The time field: computed from the position of the row, so it has no column.
<#time>
    a tss:ContextField ;
    rdfs:label "Time"@en ;
    tss:datatype xsd:dateTime .

<#reference_timestamp>
    a tss:ContextField ;
    rdfs:label "Time as written in the file"@en ;
    rdfs:comment "The start of the ${what}, in UTC, as DD.MM.YYYY hh:mm: not an xsd:dateTime, so not the time of the row."@en ;
    tss:columnName "reference_timestamp" ;
    tss:datatype xsd:string .

${definitions.join('\n\n')}
`;
  return { turtle, times: times as string[] };
}

/** Read the description back from data.geo.admin.ch: it has to conform, and every row has to be at the time in the file. */
async function check(file: string, times: string[]): Promise<void> {
  const source = await Source.open(file);
  const report = await source.validate();
  if (!report.conforms) throw new Error(`${file} does not conform: ${JSON.stringify(report.results.slice(0, 3))}`);
  let i = 0;
  for await (const row of source.read()) {
    if (row.time !== times[i]) throw new Error(`${file}: row ${i + 1} is at ${row.time}, the file says ${times[i]}`);
    i++;
  }
  if (i !== times.length) throw new Error(`${file}: ${i} rows read, the file has ${times.length}`);
}

export interface MeteoSwissExample {
  id: string;
  title: string;
  path: [string, string, string];
  description: string;
  metadata: string;
}

export const METEOSWISS = 'Switzerland · MeteoSwiss';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await rm(out, { recursive: true, force: true });
  const parameters = new Map(
    (await csvRecords(latin1(await fetchBytes(`${BASE}/ogd-smn_meta_parameters.csv`)))).map((r) => [
      r.parameter_shortname,
      { description: r.parameter_description_en, unit: r.parameter_unit },
    ]),
  );
  const stations = new Map(
    (await csvRecords(latin1(await fetchBytes(`${BASE}/ogd-smn_meta_stations.csv`)))).map((r) => [
      r.station_abbr,
      { name: r.station_name, canton: r.station_canton, height: String(Math.round(Number(r.station_height_masl))) },
    ]),
  );
  const manifest: MeteoSwissExample[] = [];
  const skipped: string[] = [];
  for (const series of SERIES) {
    for (const abbr of STATIONS) {
      const station = stations.get(abbr);
      if (!station) {
        skipped.push(`${abbr}: no such station`);
        continue;
      }
      await sleep(200);
      const metadata = `${series.file}/${abbr.toLowerCase()}.ttl`;
      const described = await describe(series, abbr, station, parameters);
      if (typeof described === 'string') {
        skipped.push(`${metadata}: ${described}`);
        continue;
      }
      const file = join(out, metadata);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, described.turtle);
      await check(file, described.times);
      const { times } = described;
      manifest.push({
        id: `meteoswiss-${series.file.replace(/_.*$/, '')}-${abbr.toLowerCase()}`,
        title: `${series.title}, ${station.name}`,
        path: [METEOSWISS, series.title, `${station.name} (${station.height} m)`],
        description: `${times.length} ${series.step === 'PT1H' ? 'hours' : 'days'} of weather at ${station.name}, ${times[0].slice(0, 10)} to ${times[times.length - 1].slice(0, 10)}, read from a static CSV file of MeteoSwiss on data.geo.admin.ch. Its times are not xsd:dateTime values, so the time of a row is its position on a time grid of ${series.step}. The weather has seasons: see the patterns tab.`,
        metadata,
      });
      console.log(`ok ${metadata.padEnd(36)} ${times.length} rows, ${times[0]} to ${times[times.length - 1]}`);
    }
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const line of skipped) console.log(`skipped ${line}`);
  console.log(`described ${manifest.length} series in ${out}, skipped ${skipped.length}`);
}
