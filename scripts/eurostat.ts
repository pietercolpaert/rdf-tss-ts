/**
 * Describes time series of Eurostat (https://ec.europa.eu/eurostat) as RDF Time Series Sources:
 * one metadata document per indicator and country, whose data file is the series as SDMX-CSV,
 * straight from the dissemination API of Eurostat. One request gives one series of a few dozen
 * kilobytes in a fraction of a second, with CORS headers, so the playground reads it from
 * Eurostat itself.
 *
 * The periods of the file (2025-10, 2025-Q3, 2025-S1, 2025-W40, 2025) are no times with a
 * timezone, so the time of a row is its position on a time grid from the start of the first
 * period, with a step of the frequency of the series. Only a series with a row for every period,
 * without gaps, fits: every series is checked before it is written. It is read with the library,
 * from Eurostat, and the time of every row has to be the start of its period.
 *
 * Not every publisher fits. Opendatasoft portals (Elia, ODRÉ, Paris, Basel, Gent, Infrabel) build
 * every export on request: a whole history takes from half a minute to two minutes, which is no
 * load to put on them from a playground. A publisher without CORS headers (the Royal
 * Meteorological Institute of Belgium, the Met Office, Open Power System Data) cannot be read
 * from a browser at all.
 *
 *   npm run examples:eurostat      (writes examples/eurostat/)
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Source } from '../src/index.js';
import { parseCsv } from '../src/formats/csv.js';
import { datatypeOf } from './datahub.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'examples', 'eurostat');
const API = 'https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data';

/* ---------- what is described ---------- */

/** The countries, and the European Union, with their entity in Wikidata: the feature of interest. */
export const GEOS: Record<string, { name: string; wikidata: string }> = {
  EU27_2020: { name: 'European Union (27)', wikidata: 'Q458' },
  BE: { name: 'Belgium', wikidata: 'Q31' },
  NL: { name: 'Netherlands', wikidata: 'Q55' },
  LU: { name: 'Luxembourg', wikidata: 'Q32' },
  DE: { name: 'Germany', wikidata: 'Q183' },
  FR: { name: 'France', wikidata: 'Q142' },
  IT: { name: 'Italy', wikidata: 'Q38' },
  ES: { name: 'Spain', wikidata: 'Q29' },
  PL: { name: 'Poland', wikidata: 'Q36' },
  SE: { name: 'Sweden', wikidata: 'Q34' },
  IE: { name: 'Ireland', wikidata: 'Q27' },
  EL: { name: 'Greece', wikidata: 'Q41' },
};

interface Indicator {
  /** The Eurostat dataset. */
  dataset: string;
  /** The key of the series in the dataset, for a country. */
  key: (geo: string) => string;
  /** The dataset in the menu of the playground. */
  title: string;
  /** What the values are. */
  label: string;
  comment: string;
  /** A QUDT unit, or `EUR-PER-KiloW-HR`, which is made here. */
  unit?: string;
}

const INDICATORS: Indicator[] = [
  {
    dataset: 'prc_hicp_manr',
    key: (geo) => `M.RCH_A.CP00.${geo}`,
    title: 'Inflation (HICP), monthly',
    label: 'Inflation, annual rate of change',
    comment: 'The annual rate of change of the Harmonised Index of Consumer Prices (HICP), all items: the change of the index of a month against the same month a year earlier, in percent.',
    unit: 'PERCENT',
  },
  {
    dataset: 'une_rt_m',
    key: (geo) => `M.SA.TOTAL.PC_ACT.T.${geo}`,
    title: 'Unemployment rate, monthly',
    label: 'Unemployment rate',
    comment: 'The unemployed as a percentage of the labour force, all ages and sexes, seasonally adjusted.',
    unit: 'PERCENT',
  },
  {
    dataset: 'sts_inpr_m',
    key: (geo) => `M.PRD.B-D.SCA.I21.${geo}`,
    title: 'Industrial production, monthly',
    label: 'Industrial production index',
    comment: 'The volume of production of industry (mining and quarrying, manufacturing, electricity and gas), seasonally and calendar adjusted, as an index with 2021 = 100.',
  },
  {
    dataset: 'irt_lt_mcby_m',
    key: (geo) => `M.MCBY.${geo}`,
    title: 'Long-term interest rate, monthly',
    label: 'Long-term interest rate',
    comment: 'The yield of government bonds with a maturity of about ten years, the convergence criterion of the Economic and Monetary Union, in percent a year.',
    unit: 'PERCENT',
  },
  {
    dataset: 'namq_10_gdp',
    key: (geo) => `Q.CLV_PCH_PRE.SCA.B1GQ.${geo}`,
    title: 'GDP growth, quarterly',
    label: 'GDP growth on the previous quarter',
    comment: 'The change of the gross domestic product in chain-linked volumes against the previous quarter, seasonally and calendar adjusted, in percent.',
    unit: 'PERCENT',
  },
  {
    dataset: 'nrg_pc_204',
    key: (geo) => `S.E7000.KWH2500-4999.KWH.I_TAX.EUR.${geo}`,
    title: 'Electricity price for households, half-yearly',
    label: 'Electricity price for households',
    comment: 'The price of electricity for household consumers using 2 500 to 5 000 kWh a year (band DC), all taxes and levies included, in euro per kilowatt-hour.',
    unit: 'EUR-PER-KiloW-HR',
  },
  {
    dataset: 'demo_r_mwk_ts',
    key: (geo) => `W.T.NR.${geo}`,
    title: 'Deaths, weekly',
    label: 'Deaths',
    comment: 'The number of deaths in a week (ISO 8601 weeks, Monday to Sunday), all sexes.',
    unit: 'NUM',
  },
  {
    dataset: 'demo_pjan',
    key: (geo) => `A.NR.TOTAL.T.${geo}`,
    title: 'Population on 1 January, yearly',
    label: 'Population on 1 January',
    comment: 'The number of inhabitants on 1 January of the year.',
    unit: 'NUM',
  },
];

/* ---------- periods ---------- */

export interface Period {
  /** The frequency: annual, half-yearly, quarterly, monthly or weekly. */
  freq: 'A' | 'S' | 'Q' | 'M' | 'W';
  /** Consecutive periods have consecutive numbers. */
  index: number;
  /** The start of the period, as YYYY-MM-DD. */
  start: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** The Monday of week 1 of an ISO 8601 year: the week with 4 January in it. */
function isoWeekOne(year: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  return new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
}

/** A period of SDMX-CSV: 2025, 2025-S1, 2025-Q3, 2025-10 or 2025-W40. */
export function parsePeriod(text: string): Period | null {
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(text))) return { freq: 'A', index: Number(m[1]), start: `${m[1]}-01-01` };
  if ((m = /^(\d{4})-S([12])$/.exec(text))) {
    const half = Number(m[2]);
    return { freq: 'S', index: Number(m[1]) * 2 + half - 1, start: `${m[1]}-${half === 1 ? '01' : '07'}-01` };
  }
  if ((m = /^(\d{4})-Q([1-4])$/.exec(text))) {
    const quarter = Number(m[2]);
    return { freq: 'Q', index: Number(m[1]) * 4 + quarter - 1, start: `${m[1]}-${pad(quarter * 3 - 2)}-01` };
  }
  if ((m = /^(\d{4})-(\d{2})$/.exec(text))) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { freq: 'M', index: Number(m[1]) * 12 + month - 1, start: `${m[1]}-${m[2]}-01` };
  }
  if ((m = /^(\d{4})-W(\d{2})$/.exec(text))) {
    const monday = new Date(isoWeekOne(Number(m[1])).getTime() + (Number(m[2]) - 1) * 7 * 86_400_000);
    // a week number past the last week of the year is no week
    if (monday.getTime() >= isoWeekOne(Number(m[1]) + 1).getTime()) return null;
    return { freq: 'W', index: Math.round(monday.getTime() / (7 * 86_400_000)), start: isoDate(monday) };
  }
  return null;
}

const STEPS: Record<Period['freq'], string> = { A: 'P1Y', S: 'P6M', Q: 'P3M', M: 'P1M', W: 'P7D' };
const IN_WORDS: Record<Period['freq'], string> = { A: 'year', S: 'half year', Q: 'quarter', M: 'month', W: 'week' };
const PERIOD_DATATYPES: Partial<Record<Period['freq'], string>> = { A: 'xsd:gYear', M: 'xsd:gYearMonth' };

/* ---------- the descriptions ---------- */

const literal = (text: string) => JSON.stringify(text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function csvRows(text: string): Promise<string[][]> {
  const rows: string[][] = [];
  async function* one() {
    yield text;
  }
  for await (const row of parseCsv(one())) rows.push(row.cells);
  return rows;
}

interface Described {
  turtle: string;
  periods: Period[];
  first: string;
  last: string;
}

async function describe(indicator: Indicator, geo: string): Promise<Described | string> {
  const url = `${API}/${indicator.dataset}/${indicator.key(geo)}?format=SDMX-CSV`;
  let text: string;
  try {
    text = await fetchText(url);
  } catch (error) {
    return (error as Error).message;
  }
  const [header, ...rows] = (await csvRows(text)).filter((r) => r.length > 1);
  const at = (name: string) => header.indexOf(name);
  if (at('TIME_PERIOD') < 0 || at('OBS_VALUE') < 0) return 'no TIME_PERIOD or OBS_VALUE column';
  if (rows.length < 4) return `only ${rows.length} rows`;
  const periods = rows.map((r) => parsePeriod(r[at('TIME_PERIOD')]));
  const bad = periods.findIndex((p) => !p);
  if (bad >= 0) return `row ${bad + 1} has no period: ${rows[bad][at('TIME_PERIOD')]}`;
  const list = periods as Period[];
  const gap = list.findIndex((p, i) => i > 0 && (p.freq !== list[0].freq || p.index !== list[i - 1].index + 1));
  if (gap >= 0) return `the periods are not consecutive: ${rows[gap - 1][at('TIME_PERIOD')]}, then ${rows[gap][at('TIME_PERIOD')]}`;
  const values = rows.map((r) => r[at('OBS_VALUE')]);
  const datatype = datatypeOf(values);
  if (!datatype) return 'the values are not numbers';
  const flags = at('OBS_FLAG') >= 0 && rows.some((r) => r[at('OBS_FLAG')] !== '');

  const freq = list[0].freq;
  const step = STEPS[freq];
  const base = `${list[0].start}T00:00:00Z`;
  const place = GEOS[geo];
  const unit = indicator.unit;
  const turtle = `@prefix tss: <https://w3id.org/tss#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix unit: <http://qudt.org/vocab/unit/> .

# ${indicator.label}, ${place.name}: the series ${indicator.key(geo)} of the Eurostat dataset
# ${indicator.dataset}, as SDMX-CSV from the dissemination API of Eurostat. This document only
# describes it: the rows are read from Eurostat. Written by scripts/eurostat.ts.
#
# The file has one row per ${IN_WORDS[freq]}, without gaps, so the time of a row is the start of its
# ${IN_WORDS[freq]}: its step on a time grid of ${step} from ${list[0].start}. The TIME_PERIOD column is
# not read as the time, and the other columns of the file are not described.
<#source>
    a tss:CSVSource ;
    rdfs:label ${literal(`${indicator.label}, ${place.name}`)}@en ;
    rdfs:comment ${literal(indicator.comment)}@en ;
    dcterms:publisher <https://ec.europa.eu/eurostat> ;
    dcterms:source <https://ec.europa.eu/eurostat/databrowser/view/${indicator.dataset}/default/table> ;
    dcterms:license <https://creativecommons.org/licenses/by/4.0/> ;
    tss:from ${literal(base)}^^xsd:dateTime ;
    tss:dataFile <${url}> ;
    tss:timeBase ${literal(base)}^^xsd:dateTime ;
    tss:timeStep ${literal(step)}^^xsd:duration ;
    tss:timeField <#time> ;
    tss:hasField <#time>,
        <#period>,
        <#value>${flags ? ',\n        <#flag>' : ''} .

# The time field: computed from the position of the row, so it has no column.
<#time>
    a tss:ContextField ;
    rdfs:label "Start of the period"@en ;
    tss:datatype xsd:dateTime .

<#period>
    a tss:ContextField ;
    rdfs:label "Period as written in the file"@en ;
    tss:columnName "TIME_PERIOD" ;
    tss:datatype ${PERIOD_DATATYPES[freq] ?? 'xsd:string'} .

<#value>
    a tss:ValueField ;
    rdfs:label ${literal(indicator.label)}@en ;
    tss:columnName "OBS_VALUE" ;
    tss:datatype ${datatype} ;
    # ${place.name} (Wikidata)
    tss:featureOfInterest <http://www.wikidata.org/entity/${place.wikidata}>${unit ? ` ;\n    tss:unit ${unit === 'EUR-PER-KiloW-HR' ? '<#EUR-PER-KiloW-HR>' : `unit:${unit}`}` : ''} .
${
  flags
    ? `
# The flag of Eurostat on a value, such as p (provisional), e (estimated) or b (a break in the series).
<#flag>
    a tss:ContextField ;
    rdfs:label "Flag"@en ;
    rdfs:comment "The flag of Eurostat on the value: b is a break in the time series, c confidential, d a definition that differs, e estimated, p provisional, u of low reliability, z not applicable."@en ;
    tss:columnName "OBS_FLAG" ;
    tss:datatype xsd:string ;
    tss:describesField <#value> .
`
    : ''
}${
  unit === 'EUR-PER-KiloW-HR'
    ? `
# QUDT has the euro and the kilowatt-hour, but not their quotient. A price is not converted to
# another currency: an exchange rate changes over time.
<#EUR-PER-KiloW-HR>
    a qudt:DerivedUnit, qudt:Unit ;
    rdfs:label "euro per kilowatt-hour"@en ;
    qudt:symbol "€/kWh" ;
    qudt:hasFactorUnit [ a qudt:FactorUnit ; qudt:exponent 1 ; qudt:hasUnit unit:CCY_EUR ],
        [ a qudt:FactorUnit ; qudt:exponent -1 ; qudt:hasUnit unit:KiloW-HR ] .
`
    : ''
}`;
  return { turtle, periods: list, first: rows[0][at('TIME_PERIOD')], last: rows[rows.length - 1][at('TIME_PERIOD')] };
}

/** Read the description back from Eurostat: it has to conform, and every row has to be at the start of its period. */
async function check(file: string, periods: Period[]): Promise<void> {
  const source = await Source.open(file);
  const report = await source.validate();
  if (!report.conforms) throw new Error(`${file} does not conform: ${JSON.stringify(report.results.slice(0, 3))}`);
  let i = 0;
  for await (const row of source.read()) {
    if (row.time !== `${periods[i]?.start}T00:00:00Z`) throw new Error(`${file}: row ${i + 1} is at ${row.time}, its period starts on ${periods[i]?.start}`);
    i++;
  }
  if (i !== periods.length) throw new Error(`${file}: ${i} rows read, the file has ${periods.length}`);
}

/** An example of the playground: its place in the menu is publisher, dataset, series. */
export interface EurostatExample {
  id: string;
  title: string;
  path: [string, string, string];
  description: string;
  metadata: string;
}

export const EUROSTAT = 'Europe · Eurostat';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await rm(out, { recursive: true, force: true });
  const manifest: EurostatExample[] = [];
  const skipped: string[] = [];
  for (const indicator of INDICATORS) {
    for (const geo of Object.keys(GEOS)) {
      // one series at a time, with a pause: the API of Eurostat is shared
      await sleep(200);
      const described = await describe(indicator, geo);
      const metadata = `${indicator.dataset}/${geo}.ttl`;
      if (typeof described === 'string') {
        skipped.push(`${metadata}: ${described}`);
        continue;
      }
      const file = join(out, metadata);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, described.turtle);
      await sleep(200);
      await check(file, described.periods);
      const freq = described.periods[0].freq;
      manifest.push({
        id: `eurostat-${indicator.dataset.replaceAll('_', '-')}-${geo.toLowerCase().replaceAll('_', '-')}`,
        title: `${indicator.label}, ${GEOS[geo].name}`,
        path: [EUROSTAT, indicator.title, GEOS[geo].name],
        description: `${described.periods.length} rows of the series ${indicator.key(geo)} of the Eurostat dataset ${indicator.dataset}, ${described.first} to ${described.last}, read from the dissemination API of Eurostat as SDMX-CSV. The periods are no times with a timezone, so the time of a row is the start of its ${IN_WORDS[freq]}, its position on a time grid of ${STEPS[freq]}.`,
        metadata,
      });
      console.log(`ok ${metadata.padEnd(30)} ${described.periods.length} rows, ${described.first} to ${described.last}`);
    }
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const line of skipped) console.log(`skipped ${line}`);
  console.log(`described ${manifest.length} series in ${out}, skipped ${skipped.length}`);
}
