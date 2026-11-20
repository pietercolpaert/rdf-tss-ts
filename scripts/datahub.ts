/**
 * Describes time series of the core datasets on GitHub (https://github.com/datasets) as RDF Time
 * Series Sources: one metadata document per CSV file, which stays where the data package
 * publishes it. Only a file with one series fits: one row per time, without a column that splits
 * the rows into several series (a country, say), and with one row at every step of a calendar
 * grid (a day, a month, a quarter, a year …), since the dates of the files are not times with a
 * timezone. The time of a row is then its position on the grid: the source has no step field.
 *
 * Every description is checked before it is written: it is read with the library, from GitHub,
 * and the time of every row has to be the date in the file.
 *
 *   npm run examples:datahub      (writes examples/datahub/)
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Source } from '../src/index.js';
import { parseCsv } from '../src/formats/csv.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'examples', 'datahub');
const RAW = 'https://raw.githubusercontent.com/datasets';

/* ---------- units ---------- */

const QUDT_UNIT = 'http://qudt.org/vocab/unit/';

/**
 * Units that QUDT does not have, made of QUDT units as QUDT makes its own: a quotient with
 * `qudt:hasFactorUnit`, a multiple with `qudt:scalingOf` and `qudt:prefix`. A unit with a
 * currency states no conversion multiplier: an exchange rate changes over time.
 */
const LOCAL_UNITS: Record<string, { label: string; symbol: string; turtle: string; uses?: string[] }> = {
  'USD-PER-BBL': { label: 'US dollar per barrel', symbol: '$/bbl', turtle: quotient('unit:CCY_USD', 'unit:BBL') },
  'USD-PER-MegaBTU_IT': { label: 'US dollar per million British thermal units', symbol: '$/MMBtu', turtle: quotient('unit:CCY_USD', 'unit:MegaBTU_IT') },
  'USD-PER-TONNE': { label: 'US dollar per metric ton', symbol: '$/t', turtle: quotient('unit:CCY_USD', 'unit:TONNE') },
  'USD-PER-M3': { label: 'US dollar per cubic metre', symbol: '$/m³', turtle: quotient('unit:CCY_USD', 'unit:M3') },
  'USD-PER-KiloGM': { label: 'US dollar per kilogram', symbol: '$/kg', turtle: quotient('unit:CCY_USD', 'unit:KiloGM') },
  'USD-PER-LB': { label: 'US dollar per pound', symbol: '$/lb', turtle: quotient('unit:CCY_USD', 'unit:LB') },
  'CentiCCY_USD': { label: 'US cent', symbol: '¢', turtle: scaled('unit:CCY_USD', 'Centi') },
  'CentiUSD-PER-LB': { label: 'US cent per pound', symbol: '¢/lb', turtle: quotient('<#CentiCCY_USD>', 'unit:LB'), uses: ['CentiCCY_USD'] },
  'CentiUSD-PER-KiloGM': { label: 'US cent per kilogram', symbol: '¢/kg', turtle: quotient('<#CentiCCY_USD>', 'unit:KiloGM'), uses: ['CentiCCY_USD'] },
  'MegaCCY_USD': { label: 'million US dollars', symbol: '$m', turtle: scaled('unit:CCY_USD', 'Mega') },
  'GigaCCY_USD': { label: 'billion US dollars', symbol: '$bn', turtle: scaled('unit:CCY_USD', 'Giga') },
  'MegaCCY_GBP': { label: 'million pounds sterling', symbol: '£m', turtle: scaled('unit:CCY_GBP', 'Mega') },
  // QUDT has no unit for a difference of temperatures in degrees Celsius; unit:DEG_C has an offset
  'DEG_C-DIFF': {
    label: 'degree Celsius, as a difference of temperatures',
    symbol: '°C',
    turtle: `a qudt:Unit ;
    qudt:hasQuantityKind quantitykind:TemperatureDifference ;
    rdfs:comment "A difference of one degree Celsius is a difference of one kelvin: unlike unit:DEG_C, it has no offset."@en`,
  },
};

function quotient(numerator: string, denominator: string): string {
  return `a qudt:DerivedUnit, qudt:Unit ;
    qudt:hasFactorUnit [ a qudt:FactorUnit ; qudt:exponent 1 ; qudt:hasUnit ${numerator} ],
        [ a qudt:FactorUnit ; qudt:exponent -1 ; qudt:hasUnit ${denominator} ]`;
}

function scaled(unit: string, prefix: string): string {
  return `a qudt:Unit ;
    qudt:scalingOf ${unit} ;
    qudt:prefix prefix:${prefix}`;
}

/** The unit a column names in its name or its description in the data package. */
function unitFromDescription(description = ''): string | undefined {
  const units: [RegExp, string][] = [
    [/\(ug\/m3\)/i, 'MicroGM-PER-M3'],
    [/USD per metric ton/i, 'USD-PER-TONNE'],
    [/US cents per pound/i, 'CentiUSD-PER-LB'],
    [/US cents per kilogram/i, 'CentiUSD-PER-KiloGM'],
    [/USD per cubic meter/i, 'USD-PER-M3'],
    [/USD per Million Metric British Thermal Unit/i, 'USD-PER-MegaBTU_IT'],
    [/USD per barrel/i, 'USD-PER-BBL'],
    [/USD per kilogram/i, 'USD-PER-KiloGM'],
    [/USD per pound/i, 'USD-PER-LB'],
  ];
  return units.find(([pattern]) => pattern.test(description))?.[1];
}

/* ---------- what is described ---------- */

interface Entry {
  repo: string;
  path: string;
  group: string;
  /** The title in the playground. */
  title: string;
  /** Units by column: a QUDT unit (`PERCENT`) or one of `LOCAL_UNITS`. */
  units?: Record<string, string>;
  /** Take the unit of every column from its name or its description. */
  unitsFromDescriptions?: boolean;
  /** Numeric columns that say something about the row, and are not readings. */
  meta?: string[];
}

const PRICES = 'Prices and markets (core datasets on GitHub)';
const ECONOMY = 'Economy (core datasets on GitHub)';
const CLIMATE = 'Climate and environment (core datasets on GitHub)';
const PEOPLE = 'Population and health (core datasets on GitHub)';
export const DATAHUB_GROUPS = [PRICES, ECONOMY, CLIMATE, PEOPLE];

const each = (columns: string[], unit: string) => Object.fromEntries(columns.map((c) => [c, unit]));

const ENTRIES: Entry[] = [
  // prices and markets
  { repo: 'oil-prices', path: 'data/brent-monthly.csv', group: PRICES, title: 'Brent crude oil, monthly', units: { Price: 'USD-PER-BBL' } },
  { repo: 'oil-prices', path: 'data/brent-year.csv', group: PRICES, title: 'Brent crude oil, yearly', units: { Price: 'USD-PER-BBL' } },
  { repo: 'oil-prices', path: 'data/wti-monthly.csv', group: PRICES, title: 'WTI crude oil, monthly', units: { Price: 'USD-PER-BBL' } },
  { repo: 'oil-prices', path: 'data/wti-year.csv', group: PRICES, title: 'WTI crude oil, yearly', units: { Price: 'USD-PER-BBL' } },
  { repo: 'natural-gas', path: 'data/monthly-processed.csv', group: PRICES, title: 'Natural gas (Henry Hub), monthly', units: { Price: 'USD-PER-MegaBTU_IT' } },
  { repo: 'commodity-prices', path: 'data/commodity-prices_v2.csv', group: PRICES, title: '63 commodity prices and indices, monthly', unitsFromDescriptions: true },
  {
    repo: 's-and-p-500',
    path: 'data/data.csv',
    group: PRICES,
    title: 'S&P 500, dividends and earnings since 1871',
    units: { Dividend: 'CCY_USD', Earnings: 'CCY_USD', 'Long Interest Rate': 'PERCENT', 'Real Price': 'CCY_USD', 'Real Dividend': 'CCY_USD', 'Real Earnings': 'CCY_USD' },
  },
  { repo: 'bond-yields-us-10y', path: 'data/monthly.csv', group: PRICES, title: 'US 10-year government bond yield, monthly', units: { Rate: 'PERCENT' } },
  { repo: 'bond-yields-uk-10y', path: 'data/annual.csv', group: PRICES, title: 'UK 10-year government bond yield, yearly', units: { Rate: 'PERCENT' } },
  // economy
  {
    repo: 'gdp-us',
    path: 'data/quarter.csv',
    group: ECONOMY,
    title: 'US GDP, quarterly',
    units: { 'level-current': 'GigaCCY_USD', 'level-chained': 'GigaCCY_USD', 'change-current': 'PERCENT', 'change-chained': 'PERCENT' },
  },
  {
    repo: 'gdp-us',
    path: 'data/year.csv',
    group: ECONOMY,
    title: 'US GDP, yearly',
    units: { 'level-current': 'GigaCCY_USD', 'level-chained': 'GigaCCY_USD', 'change-current': 'PERCENT', 'change-chained': 'PERCENT' },
  },
  { repo: 'gdp-uk', path: 'data/data.csv', group: ECONOMY, title: 'UK GDP, yearly', units: { GDP: 'MegaCCY_GBP' } },
  { repo: 'cpi-gb', path: 'data/cpi-uk-monthly.csv', group: ECONOMY, title: 'UK consumer price index, monthly' },
  { repo: 'cpi-gb', path: 'data/cpi-uk-annual.csv', group: ECONOMY, title: 'UK consumer price index, yearly since 1800' },
  { repo: 'cpi-gb', path: 'data/inflation-uk.csv', group: ECONOMY, title: 'UK inflation, yearly since 1800', units: { Inflation: 'PERCENT' } },
  { repo: 'house-prices-us', path: 'data/national-month.csv', group: ECONOMY, title: 'US national home price index (Case-Shiller)' },
  { repo: 'house-prices-us', path: 'data/cities-month-SA.csv', group: ECONOMY, title: 'US home price index of 20 cities, seasonally adjusted' },
  { repo: 'house-prices-us', path: 'data/cities-month-NSA.csv', group: ECONOMY, title: 'US home price index of 20 cities, not seasonally adjusted' },
  { repo: 'house-prices-uk', path: 'data/data.csv', group: ECONOMY, title: 'UK house prices, quarterly' },
  { repo: 'house-prices-fr', path: 'data/paris.csv', group: ECONOMY, title: 'House price index of Paris since 1200' },
  {
    repo: 'usa-education-budget-analysis',
    path: 'data/data.csv',
    group: ECONOMY,
    title: 'US education budget and GDP',
    units: { BUDGET_ON_EDUCATION: 'MegaCCY_USD', GDP: 'MegaCCY_USD', RATIO: 'PERCENT' },
  },
  // climate and environment
  { repo: 'co2-ppm', path: 'data/co2-mm-mlo.csv', group: CLIMATE, title: 'CO₂ at Mauna Loa, monthly', units: { Average: 'PPM', Interpolated: 'PPM', Trend: 'PPM', 'Number of Days': 'NUM' }, meta: ['Decimal Date'] },
  { repo: 'co2-ppm', path: 'data/co2-annmean-mlo.csv', group: CLIMATE, title: 'CO₂ at Mauna Loa, yearly', units: { Mean: 'PPM', Uncertainty: 'PPM' } },
  { repo: 'co2-ppm', path: 'data/co2-gr-mlo.csv', group: CLIMATE, title: 'CO₂ increase at Mauna Loa, yearly', units: { 'Annual Increase': 'PPM', Uncertainty: 'PPM' } },
  { repo: 'co2-ppm', path: 'data/co2-mm-gl.csv', group: CLIMATE, title: 'CO₂, global, monthly', units: { Average: 'PPM', Trend: 'PPM' }, meta: ['Decimal Date'] },
  { repo: 'co2-ppm', path: 'data/co2-annmean-gl.csv', group: CLIMATE, title: 'CO₂, global, yearly', units: { Mean: 'PPM', Uncertainty: 'PPM' } },
  { repo: 'co2-ppm', path: 'data/co2-gr-gl.csv', group: CLIMATE, title: 'CO₂ increase, global, yearly', units: { 'Annual Increase': 'PPM', Uncertainty: 'PPM' } },
  {
    repo: 'co2-fossil-global',
    path: 'data/global.csv',
    group: CLIMATE,
    title: 'CO₂ emissions from fossil fuels since 1750',
    units: { ...each(['Total', 'Gas Fuel', 'Liquid Fuel', 'Solid Fuel', 'Cement', 'Gas Flaring'], 'MegaTONNE'), 'Per Capita': 'TONNE' },
  },
  {
    repo: 'global-temp-anomalies',
    path: 'data/global-temp-annual.csv',
    group: CLIMATE,
    title: 'Global temperature anomalies (GISTEMP), yearly',
    units: each(['Land', 'Land and Ocean', 'N Hem', 'S Hem', 'Band 1', 'Band 2', 'Band 3'], 'DEG_C-DIFF'),
  },
  {
    repo: 'global-temp-anomalies',
    path: 'data/global-temp-5yr.csv',
    group: CLIMATE,
    title: 'Global temperature anomalies (GISTEMP), 5-year means',
    units: each(['Land', 'Land and Ocean', 'N Hem', 'S Hem', 'Band 1', 'Band 2', 'Band 3'], 'DEG_C-DIFF'),
  },
  { repo: 'sea-level-rise', path: 'data/epa-sea-level.csv', group: CLIMATE, title: 'Sea level (EPA), yearly since 1880', units: each(['CSIRO Adjusted Sea Level', 'Lower Error Bound', 'Upper Error Bound', 'NOAA Adjusted Sea Level'], 'IN') },
  { repo: 'sea-level-rise', path: 'data/CSIRO_Recons_gmsl_yr_2019.csv', group: CLIMATE, title: 'Sea level (CSIRO reconstruction), yearly since 1880', units: { GMSL: 'MilliM', 'GMSL uncertainty': 'MilliM' } },
  { repo: 'sea-level-rise', path: 'data/CSIRO_Alt_yearly.csv', group: CLIMATE, title: 'Sea level (CSIRO, satellite altimetry), yearly', units: { 'GMSL (yearly)': 'MilliM' } },
  { repo: 'glacier-mass-balance', path: 'data/glaciers.csv', group: CLIMATE, title: 'Mass balance of reference glaciers', units: { 'Number of observations': 'NUM' } },
  { repo: 'london-air-quality', path: 'data/monthly-averages.csv', group: CLIMATE, title: 'Air quality in London, monthly', unitsFromDescriptions: true },
  // population and health
  { repo: 'covid-19', path: 'data/worldwide-aggregate.csv', group: PEOPLE, title: 'COVID-19 worldwide, daily', units: { Confirmed: 'NUM', Recovered: 'NUM', Deaths: 'NUM' } },
  { repo: 'covid-19', path: 'data/key-countries-pivoted.csv', group: PEOPLE, title: 'COVID-19 in eight countries, daily', units: each(['China', 'US', 'United_Kingdom', 'Italy', 'France', 'Germany', 'Spain', 'Iran'], 'NUM') },
  { repo: 'covid-19', path: 'data/worldwide-mortality-rate.csv', group: PEOPLE, title: 'COVID-19 mortality rate, worldwide, daily' },
  { repo: 'london-population', path: 'data/london-population-history.csv', group: PEOPLE, title: 'Population of London since 1961', units: { Value: 'NUM' } },
  { repo: 'london-population', path: 'data/london-population-projection.csv', group: PEOPLE, title: 'Population of London, projected to 2050', units: { Value: 'NUM' } },
  { repo: 'world-religion-projections', path: 'world.csv', group: PEOPLE, title: 'World religion projections, 2010 to 2050', units: { Christians: 'NUM', Muslims: 'NUM', Hindus: 'NUM' } },
];

/* ---------- the grid ---------- */

interface Day {
  year: number;
  month: number;
  day: number;
  /** How precise the date in the file is. */
  precision: 'year' | 'month' | 'day';
}

export function parseDay(text: string): Day | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text.trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2] ?? 1), day: Number(m[3] ?? 1), precision: m[3] ? 'day' : m[2] ? 'month' : 'year' };
}

/** A step in words: `P1M` is a month, `P3M` a quarter. */
const stepInWords = (step: string) =>
  ({ P1D: 'day', P7D: 'week', P1M: 'month', P3M: 'quarter', P1Y: 'year' })[step] ?? step.replace(/^P(\d+)([DMY])$/, (_, n, u) => `${n} ${{ D: 'days', M: 'months', Y: 'years' }[u as 'D']}`);

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const dayText = (d: Day) => `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
const utcDays = (d: Day) => Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;

/** The step of a calendar grid that every date is on, one row per step from the first; `null` when there is none. */
export function gridStep(days: Day[]): string | null {
  if (days.length < 2) return null;
  const months = days.map((d) => d.year * 12 + d.month - 1);
  if (days.every((d) => d.day === days[0].day)) {
    const steps = new Set(months.slice(1).map((m, i) => m - months[i]));
    if (steps.size === 1) {
      const n = [...steps][0];
      if (n > 0) return n % 12 === 0 ? `P${n / 12}Y` : `P${n}M`;
    }
  }
  const steps = new Set(days.slice(1).map((d, i) => utcDays(d) - utcDays(days[i])));
  if (steps.size === 1) {
    const n = [...steps][0];
    if (n > 0) return `P${n}D`;
  }
  return null;
}

/* ---------- datatypes ---------- */

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const DOUBLE = /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/;

/** The datatype of a column: the narrowest of integer, decimal and double its values fit; `null` for text. */
export function datatypeOf(values: string[]): string | null {
  const present = values.filter((v) => v !== '');
  if (present.every((v) => INTEGER.test(v))) return 'xsd:integer';
  if (present.every((v) => DECIMAL.test(v))) return 'xsd:decimal';
  if (present.every((v) => DOUBLE.test(v))) return 'xsd:double';
  return null;
}

/* ---------- Turtle ---------- */

const literal = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'field';

interface DataPackage {
  title?: string;
  description?: string;
  homepage?: string;
  licenses?: { name?: string; path?: string; title?: string }[];
  resources: { path: string; description?: string; schema?: { fields?: { name: string; type?: string; description?: string }[] } }[];
}

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

const TIME_TYPES = new Set(['date', 'datetime', 'year', 'yearmonth']);

async function describe(entry: Entry): Promise<{ turtle: string; rows: number; dates: string[]; step: string; dateColumn: string; precision: Day['precision'] }> {
  const packageUrl = `${RAW}/${entry.repo}/main/datapackage.json`;
  const dataUrl = `${RAW}/${entry.repo}/main/${entry.path}`;
  const dp = JSON.parse(await fetchText(packageUrl)) as DataPackage;
  const resource = dp.resources.find((r) => r.path === entry.path);
  if (!resource) throw new Error(`${entry.repo} has no resource ${entry.path}`);
  const described = new Map((resource.schema?.fields ?? []).map((f) => [f.name, f]));
  const [header, ...rows] = (await csvRows(await fetchText(dataUrl))).filter((r) => r.length > 1 || r[0] !== '');

  // the time column: the one the data package gives a time type, or names Date, Year, Month or Time
  const timeColumn = header.find((h) => TIME_TYPES.has(described.get(h)?.type ?? '')) ?? header.find((h) => /^(date|year|month|time)$/i.test(h));
  if (!timeColumn) throw new Error(`${entry.path}: no time column`);
  const at = header.indexOf(timeColumn);
  const days = rows.map((r) => parseDay(r[at] ?? ''));
  const bad = rows.findIndex((_, i) => !days[i]);
  if (bad >= 0) throw new Error(`${entry.path}: row ${bad + 1} has no date: ${JSON.stringify(rows[bad][at])}`);
  const step = gridStep(days as Day[]);
  if (!step) throw new Error(`${entry.path}: the rows are not one step apart`);
  const first = days[0]!;
  const base = `${dayText(first)}T00:00:00Z`;

  // the other columns
  const fields: string[] = [];
  const definitions: string[] = [];
  const usedUnits = new Set<string>();
  const ids = new Set(['time', 'date']);
  const idOf = (column: string) => {
    let id = slug(column);
    while (ids.has(id)) id += '-';
    ids.add(id);
    return id;
  };
  for (const [index, column] of header.entries()) {
    if (index === at) continue;
    const values = rows.map((r) => r[index] ?? '');
    const datatype = datatypeOf(values);
    const description = described.get(column)?.description;
    if (!datatype) {
      if (new Set(values).size > 1) throw new Error(`${entry.path}: ${column} is text with several values: the file holds several series`);
      continue;
    }
    const id = idOf(column);
    fields.push(`<#${id}>`);
    const meta = entry.meta?.includes(column);
    const unit = entry.unitsFromDescriptions ? unitFromDescription(`${column} ${description ?? ''}`) : entry.units?.[column];
    if (unit) usedUnits.add(unit);
    const lines = [
      `<#${id}>`,
      `    a ${meta ? 'tss:MetaField' : 'tss:ValueField'} ;`,
      `    rdfs:label ${literal(column)}@en ;`,
      ...(description ? [`    rdfs:comment ${literal(description)}@en ;`] : []),
      `    tss:columnName ${literal(column)} ;`,
      `    tss:datatype ${datatype}${unit ? ' ;' : ' .'}`,
      ...(unit ? [`    tss:unit ${unit in LOCAL_UNITS ? `<#${unit}>` : `unit:${unit}`} .`] : []),
    ];
    definitions.push(lines.join('\n'));
  }
  for (const column of Object.keys(entry.units ?? {})) {
    if (!header.includes(column)) throw new Error(`${entry.path}: no column ${column} to give a unit`);
  }

  // the units made here, and the ones they are made of
  const local = new Set<string>();
  const add = (key: string) => {
    if (!(key in LOCAL_UNITS) || local.has(key)) return;
    local.add(key);
    for (const used of LOCAL_UNITS[key].uses ?? []) add(used);
  };
  for (const unit of usedUnits) add(unit);
  const unitDefinitions = [...local].sort().map((key) => {
    const u = LOCAL_UNITS[key];
    return `<#${key}>\n    ${u.turtle} ;\n    rdfs:label ${literal(u.label)}@en ;\n    qudt:symbol ${literal(u.symbol)} .`;
  });

  const license = dp.licenses?.find((l) => l.path)?.path;
  const dateType = first.precision === 'day' ? 'xsd:date' : first.precision === 'month' ? 'xsd:gYearMonth' : 'xsd:gYear';
  const comment = resource.description || dp.description;
  const turtle = `@prefix tss: <https://w3id.org/tss#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix prefix: <http://qudt.org/vocab/prefix/> .
@prefix quantitykind: <http://qudt.org/vocab/quantitykind/> .

# ${entry.path} of the data package ${dp.title ? `"${dp.title}" ` : ''}on GitHub (https://github.com/datasets/${entry.repo}).
# This document only describes the CSV file: the rows are read from where the data package
# publishes them. Written by scripts/datahub.ts.
#
# The file has one row per ${stepInWords(step)}, without gaps, so the time of a row is its step on a
# time grid of ${step} from ${dayText(first)}: the source has no step field, and its ${timeColumn} column
# is not read as the time.
<#source>
    a tss:CSVSource ;
    rdfs:label ${literal(entry.title)}@en ;
${comment ? `    rdfs:comment ${literal(comment)}@en ;\n` : ''}    dcterms:source <https://github.com/datasets/${entry.repo}> ;
${license ? `    dcterms:license <${license}> ;\n` : ''}    rdfs:seeAlso <${packageUrl}> ;
    tss:from ${literal(base)}^^xsd:dateTime ;
    tss:dataFile <${dataUrl}> ;
    tss:timeBase ${literal(base)}^^xsd:dateTime ;
    tss:timeStep ${literal(step)}^^xsd:duration ;
    tss:timeField <#time> ;
    tss:hasField <#time>,
        <#date>,
        ${fields.join(',\n        ')} .

# The time field: computed from the position of the row, so it has no column.
<#time>
    a tss:MetaField ;
    rdfs:label "Time"@en ;
    tss:datatype xsd:dateTime .

<#date>
    a tss:MetaField ;
    rdfs:label ${literal(`${timeColumn} as written in the file`)}@en ;
    rdfs:comment "A date without a time of day and a timezone, so it is not the time of the row."@en ;
    tss:columnName ${literal(timeColumn)} ;
    tss:datatype ${dateType} .

${definitions.join('\n\n')}
${unitDefinitions.length ? `\n# Units that QUDT does not have, made of QUDT units. A unit with a currency states no conversion\n# multiplier: an exchange rate changes over time.\n${unitDefinitions.join('\n\n')}\n` : ''}`;
  return { turtle, rows: rows.length, dates: rows.map((r) => r[at]), step, dateColumn: timeColumn, precision: first.precision };
}

/** Read the description with the library, from GitHub: it conforms, and every row is at the date of the file. */
async function check(file: string, expected: { rows: number; dates: string[]; precision: Day['precision'] }): Promise<void> {
  const source = await Source.open(file);
  const report = await source.validate();
  if (!report.conforms) throw new Error(`${file} does not conform: ${JSON.stringify(report.results.slice(0, 3))}`);
  let i = 0;
  for await (const row of source.read()) {
    const date = expected.dates[i];
    const day = parseDay(date)!;
    if (row.time !== `${dayText(day)}T00:00:00Z`) throw new Error(`${file}: row ${i + 1} is at ${row.time}, the file says ${date}`);
    i++;
  }
  if (i !== expected.rows) throw new Error(`${file}: ${i} rows read, the file has ${expected.rows}`);
}

export interface DatahubExample {
  id: string;
  title: string;
  group: string;
  description: string;
  metadata: string;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await rm(out, { recursive: true, force: true });
  const manifest: DatahubExample[] = [];
  for (const entry of ENTRIES) {
    const name = entry.path.split('/').pop()!.replace(/\.csv$/, '');
    const metadata = `${entry.repo}/${name}.ttl`;
    const file = join(out, metadata);
    const { turtle, ...expected } = await describe(entry);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, turtle);
    await check(file, expected);
    manifest.push({
      id: `datahub-${entry.repo}-${slug(name)}`,
      title: entry.title,
      group: entry.group,
      description: `${expected.rows} rows of ${entry.path} in the ${entry.repo} data package on GitHub, one per ${stepInWords(expected.step)}. The ${expected.dateColumn} column holds ${expected.precision === 'day' ? 'dates' : expected.precision === 'month' ? 'months' : 'years'}, not times with a timezone, so the time of a row is its position on a time grid of ${expected.step} from ${expected.dates[0]}.`,
      metadata,
    });
    console.log(`ok ${metadata.padEnd(60)} ${expected.rows} rows, one per ${stepInWords(expected.step)}`);
  }
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`described ${manifest.length} files in ${out}`);
}
