import {
  Source,
  UnitConversionError,
  createEyemindUnitConverter,
  serializeRdf,
  type FieldMetadata,
  type RDFMessage,
  type ReadableSource,
  type Row,
  type AlignerOptions,
  type UnitConverter,
  unitDefinitions,
  TSS_VOCABULARY_SOURCE,
} from '../src/index.js';
import { ZoomGroup, renderChart, type Series } from './chart.js';
import { highlightTurtle } from './highlight.js';
import { renderPatterns } from './patterns.js';

interface Example {
  id: string;
  title: string;
  group: string;
  /** Its place in the menu: a publisher, a dataset and, for a dataset of several series, the series. */
  path: string[];
  description: string;
  metadata: string;
  kind: string;
}

interface Compaction {
  day: string;
  source: string;
  members: number;
  ldes: { members: number; bytes: number; gzip: number };
  locations: {
    id: string;
    location: string;
    ldes: { members: number; bytes: number; gzip: number };
    source: Record<string, { metadata: number; data: number; total: number; gzip: number }>;
  }[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SYMBOLS: Record<string, string> = {
  DEG_C: '°C', DEG_F: '°F', K: 'K', PERCENT: '%', UNITLESS: '1', 'KiloM-PER-HR': 'km/h', 'M-PER-SEC': 'm/s', 'MI-PER-HR': 'mph', KN: 'kn',
  KiloPA: 'kPa', PA: 'Pa', BAR: 'bar', M: 'm', KiloM: 'km', CentiM: 'cm', MilliM: 'mm', IN: 'in', FT: 'ft', MI: 'mi', SEC: 's', MIN: 'min', HR: 'h', DAY: 'd',
  KiloGM: 'kg', GM: 'g', LB: 'lb', J: 'J', KiloJ: 'kJ', W: 'W', KiloW: 'kW', L: 'L', MilliL: 'mL', M2: 'm²', M3: 'm³',
  TONNE: 't', MegaTONNE: 'Mt', PPM: 'ppm', NUM: 'count', 'MicroGM-PER-M3': 'µg/m³', CCY_USD: '$', CCY_GBP: '£', CCY_EUR: '€',
  HectoPA: 'hPa', 'W-PER-M2': 'W/m²',
};
const FAMILIES = [
  ['DEG_C', 'DEG_F', 'K'],
  ['KiloM-PER-HR', 'M-PER-SEC', 'MI-PER-HR', 'KN'],
  ['HectoPA', 'KiloPA', 'PA', 'BAR'],
  ['PERCENT', 'UNITLESS'],
  ['M', 'KiloM', 'CentiM', 'MilliM', 'IN', 'FT', 'MI'],
  ['SEC', 'MIN', 'HR', 'DAY'],
  ['KiloGM', 'GM', 'LB'],
  ['J', 'KiloJ'],
  ['W', 'KiloW'],
  ['L', 'MilliL', 'M3'],
];
const QUDT_UNIT = 'http://qudt.org/vocab/unit/';
const PREFIXES = {
  tss: 'https://w3id.org/tss#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  sosa: 'http://www.w3.org/ns/sosa/',
  qudt: 'http://qudt.org/schema/qudt/',
  unit: QUDT_UNIT,
  qk: 'http://qudt.org/vocab/quantitykind/',
  dcterms: 'http://purl.org/dc/terms/',
  telraam: 'https://telraam.net/en/location/',
  verkeer: 'https://data.vlaanderen.be/ns/verkeersmetingen#',
  impl: 'https://implementatie.data.vlaanderen.be/ns/vsds-verkeersmetingen#',
  'cl-vrt': 'https://data.vlaanderen.be/doc/concept/VkmVoertuigType/',
  'cl-vkt': 'https://data.vlaanderen.be/doc/concept/VkmVerkeersKenmerkType/',
  'cl-mit': 'https://data.vlaanderen.be/doc/concept/VkmMeetInstrumentType/',
  'cl-trt': 'https://inspire.ec.europa.eu/codelist/LinkDirectionValue/',
};

/** eyemind (490 kB) is only loaded when a unit is converted. */
let converter: UnitConverter | undefined;
const lazyConverter: UnitConverter = {
  async conversion(from, to, options) {
    // @ts-expect-error resolved by the bundler: the command line entry of eyemind, which has the QUDT profile
    converter ??= createEyemindUnitConverter({ main: (await import('eyemind-cli')).main });
    return converter.conversion(from, to, options);
  },
};

/** The reasoner of eyemind over messages, with its OWL 2 RL profile, is only loaded when the alignment is derived. */
let aligner: Promise<AlignerOptions> | undefined;
const loadAligner = () =>
  (aligner ??= Promise.all([
    // @ts-expect-error resolved by the bundler: eyemind/src/formats.js
    import('eyemind-formats'),
    // @ts-expect-error resolved by the bundler: eyemind/src/messages.js
    import('eyemind-messages'),
    // @ts-expect-error resolved by the bundler: eyemind/src/rdf.js
    import('eyemind-rdf'),
  ]).then(([formats, messages, rdf]) => ({
    eyemind: { loadMessageReasoner: formats.loadMessageReasoner, parseRdfMessages: messages.parseRdfMessages, writeRdf: rdf.writeRdf },
  })));

/**
 * The view, in the hash after the dataset: `#weather-csv&tab=messages&rows=5&align=sosa`. The
 * dataset comes first, as an example id or an encoded URL, so a link of only a dataset still
 * works; then the tab and the choices made in it.
 */
let view = new URLSearchParams();

function datasetOfHash(): { dataset: string; params: URLSearchParams } {
  const raw = location.hash.slice(1);
  const at = raw.indexOf('&');
  return { dataset: decodeURIComponent(at < 0 ? raw : raw.slice(0, at)), params: new URLSearchParams(at < 0 ? '' : raw.slice(at + 1)) };
}

function writeHash(): void {
  if (!state) return;
  const dataset = state.example ? state.example.id : encodeURIComponent(state.url);
  // colons and slashes may stay as they are in a hash: times and IRIs read better
  const params = view.toString().replace(/%3A/g, ':').replace(/%2F/g, '/');
  history.replaceState(null, '', `#${dataset}${params ? `&${params}` : ''}`);
}

/** Change the view: a key with `undefined` is left out, as is its default. */
function setView(changes: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === '') view.delete(key);
    else view.set(key, value);
  }
  writeHash();
}

/** A unit in a link: the name of a QUDT unit, `qudt`, or the IRI of another unit. */
const unitParam = (unit: string) => (unit.startsWith(QUDT_UNIT) ? unit.slice(QUDT_UNIT.length) : unit);
const unitOfParam = (text: string) => (text === 'qudt' || /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : QUDT_UNIT + text);

interface State {
  url: string;
  example?: Example;
  source: ReadableSource;
  times: string[];
  /** The values shown for every field, aligned with `times`, and their unit. */
  values: Map<string, (string | undefined)[]>;
  unit: Map<string, string | undefined>;
  selectedUnit: Map<string, string>;
  rendered: Set<string>;
  stopCharts: (() => void)[];
}
let state: State | undefined;
let examples: Example[] = [];
let compaction: Compaction | undefined;

/** The `qudt:symbol` of the units the metadata defines itself, such as a unit made of QUDT units. */
const unitSymbols = new Map<string, string>();
const symbol = (iri?: string) =>
  iri ? (unitSymbols.get(iri) ?? SYMBOLS[iri.replace(QUDT_UNIT, '')] ?? (iri.startsWith(QUDT_UNIT) ? qudtTable?.units[iri.slice(QUDT_UNIT.length)]?.[0] : undefined) ?? iri.replace(QUDT_UNIT, '')) : '';

/**
 * The units of QUDT that eyemind converts, with their symbol, label, quantity kinds, whether they
 * are SI units and whether they have an offset: playground/qudt-units.json, written by
 * scripts/qudt-units.ts. Loaded with the first chart that has a unit.
 */
interface QudtUnits {
  release: string;
  units: Record<string, [symbol: string, label: string, kinds: string[], si: 0 | 1, offset: 0 | 1, common: number, multiplier: number]>;
}
let qudtTable: QudtUnits | undefined;
let qudtLoading: Promise<QudtUnits | undefined> | undefined;
const loadQudtUnits = () =>
  (qudtLoading ??= fetch('qudt-units.json')
    .then((r) => (r.ok ? (r.json() as Promise<QudtUnits>) : undefined))
    .then((table) => (qudtTable = table))
    .catch(() => undefined));

const QK = 'http://qudt.org/vocab/quantitykind/';
/** Quantity kinds of differences of values: a unit with an offset, such as °C, is none of theirs. */
const DIFFERENCES = new Set(['TemperatureDifference']);

/** At most this many units to choose from. */
const MAX_CHOICES = 15;
/** A unit more orders of magnitude away than this is no way to read the values (MK for °C, pW/m² for W/m²). */
const MAX_ORDERS = 3;

/**
 * The units a reading in `unit` can be shown in: units of QUDT of its quantity kinds. Those are
 * the `tss:observedProperty` of the field when it is a quantity kind of QUDT, and the quantity
 * kinds of the unit, in QUDT or in the metadata (`qudt:hasQuantityKind`). A unit has to share at
 * least a quarter as much of its quantity kinds as the closest one does (so % gets ‰ and ratios,
 * not bar per bar), and lie within a few orders of magnitude. SI units come first, then the most
 * common ones, with the most codes in other systems, then the closest.
 */
function unitChoices(field: FieldMetadata, unit: string): string[] {
  if (!qudtTable) return familyOf(unit) ?? [];
  const table = qudtTable.units;
  const name = unit.startsWith(QUDT_UNIT) ? unit.slice(QUDT_UNIT.length) : undefined;
  const kinds = new Set([
    ...(field.observedProperty?.startsWith(QK) ? [field.observedProperty.slice(QK.length)] : []),
    ...(name && table[name]
      ? table[name][2]
      : [...state!.source.dataset.match(null, null, null)]
          .filter((q) => q.subject.value === unit && q.predicate.value === 'http://qudt.org/schema/qudt/hasQuantityKind' && q.object.value.startsWith(QK))
          .map((q) => q.object.value.slice(QK.length))),
  ]);
  const difference = [...kinds].some((k) => DIFFERENCES.has(k));
  const multiplier = name ? table[name]?.[6] : undefined;
  const ranked: { iri: string; closeness: number; si: number; common: number; orders: number; label: string }[] = [];
  for (const [other, [, label, otherKinds, si, offset, common, otherMultiplier]] of Object.entries(table)) {
    if (other === name || other.startsWith('Planck') || (difference && offset)) continue;
    const shared = otherKinds.filter((k) => kinds.has(k)).length;
    if (shared === 0) continue;
    const orders = multiplier ? Math.abs(Math.log10(otherMultiplier / multiplier)) : 0;
    if (orders > MAX_ORDERS + 1e-9) continue;
    // the share of the quantity kinds of both units that they have in common
    const closeness = shared / new Set([...kinds, ...otherKinds]).size;
    ranked.push({ iri: QUDT_UNIT + other, closeness, si, common, orders, label });
  }
  const best = Math.max(0, ...ranked.map((r) => r.closeness));
  return ranked
    .filter((r) => r.closeness >= best / 4)
    .sort((a, b) => b.si - a.si || b.common - a.common || b.closeness - a.closeness || a.orders - b.orders || a.label.localeCompare(b.label))
    .slice(0, MAX_CHOICES)
    .map((r) => r.iri);
}
/**
 * A unit of the QUDT catalog, or one the metadata makes itself (of QUDT units, or with its own
 * conversion multiplier), can be converted; a currency cannot, as its exchange rate changes
 * over time, and neither can a unit made with one.
 */
const convertible = (iri?: string) => {
  if (!iri) return false;
  if (iri.startsWith(QUDT_UNIT)) return !iri.startsWith(`${QUDT_UNIT}CCY_`);
  const definitions = state ? unitDefinitions(state.source.dataset, iri) : '';
  return definitions !== '' && !definitions.includes(`${QUDT_UNIT}CCY_`);
};

const QUDT_SCHEMA = 'http://qudt.org/schema/qudt/';
/** What the interval of the values of a field is, by the property of the describing fields that state it. */
interface Interval {
  /** `qudt:standardUncertainty`: one standard deviation either side; else the bounds. */
  uncertainty?: FieldMetadata;
  lower?: FieldMetadata;
  upper?: FieldMetadata;
  /** The bounds are `schema:minValue` and `schema:maxValue`, the range of the values over the period, rather than `qudt:lowerBound` and `qudt:upperBound`. */
  range?: boolean;
}
const SCHEMA = 'https://schema.org/';

/** The describing fields that give an interval around the values of `field`: a standard uncertainty, or lower and upper bounds. */
function intervalOf(field: FieldMetadata): Interval | undefined {
  const describing = state!.source.metadata.fields.filter((f) => f.kind === 'context' && f.describesField.includes(field.id) && isNumeric(f));
  const by = (iri: string) => describing.find((f) => f.property === iri);
  const uncertainty = by(QUDT_SCHEMA + 'standardUncertainty');
  if (uncertainty) return { uncertainty };
  const [lower, upper] = [by(QUDT_SCHEMA + 'lowerBound'), by(QUDT_SCHEMA + 'upperBound')];
  if (lower && upper) return { lower, upper };
  const [min, max] = [by(SCHEMA + 'minValue'), by(SCHEMA + 'maxValue')];
  if (min && max) return { lower: min, upper: max, range: true };
  return undefined;
}
const intervalFields = (fields: FieldMetadata[]) =>
  fields.flatMap((f) => {
    const interval = intervalOf(f);
    return interval ? [interval.uncertainty, interval.lower, interval.upper].filter((d): d is FieldMetadata => d !== undefined) : [];
  });
const label = (f: FieldMetadata) => f.labels[0] ?? f.localName;
const local = (iri: string) => iri.replace(/[#/]+$/, '').split(/[#/]/).pop() ?? iri;
const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);
const fmtRatio = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

function setStatus(message: string, error = false): void {
  const status = $('status');
  status.textContent = message;
  status.className = error ? 'status error' : 'status';
  status.hidden = message === '';
}

async function readAll(source: ReadableSource, options: { fields?: string[]; unit?: string } = {}): Promise<Row[]> {
  const out: Row[] = [];
  for await (const reading of source.read(options)) out.push(reading);
  return out;
}

const isNumeric = (f: FieldMetadata) => /#(double|float|decimal|integer|long|int|short|byte|nonNegativeInteger|positiveInteger|unsigned\w+)$/.test(f.datatype);

/** Fields with the same property and unit share a chart. */
function groups(source: ReadableSource): Map<string, FieldMetadata[]> {
  const { timeField, stepField } = source.metadata;
  const out = new Map<string, FieldMetadata[]>();
  for (const f of source.metadata.fields) {
    // a context field gives the context of a row, such as its date as a number: its values are no readings
    if (f.id === timeField || f.id === stepField || f.kind === 'context' || !isNumeric(f)) continue;
    const key = f.observedProperty || f.unit ? `${f.observedProperty ?? ''}|${f.unit ?? ''}` : f.id;
    out.set(key, [...(out.get(key) ?? []), f]);
  }
  return out;
}

function familyOf(unit?: string): string[] | undefined {
  const name = unit?.replace(QUDT_UNIT, '');
  return FAMILIES.find((family) => name && family.includes(name))?.map((n) => QUDT_UNIT + n);
}

async function open(url: string, example?: Example, params = new URLSearchParams()): Promise<void> {
  setStatus(`Fetching ${url} …`);
  $('result').hidden = true;
  for (const stop of state?.stopCharts ?? []) stop();
  try {
    const source = await Source.fetch(url, { unitConverter: lazyConverter });
    const units = new Set(source.metadata.fields.map((f) => f.unit).filter((u): u is string => !!u));
    unitSymbols.clear();
    for (const q of source.dataset.match()) {
      if (q.predicate.value === 'http://qudt.org/schema/qudt/symbol' && units.has(q.subject.value)) unitSymbols.set(q.subject.value, q.object.value);
    }
    const readings = await readAll(source);
    const values = new Map<string, (string | undefined)[]>();
    const unit = new Map<string, string | undefined>();
    for (const f of source.metadata.fields) {
      values.set(f.id, readings.map((r) => r.get(f.id)?.value));
      unit.set(f.id, f.unit);
    }
    state = { url, example, source, times: readings.map((r) => r.time), values, unit, selectedUnit: new Map(), rendered: new Set(), stopCharts: [] };
    view = params;
    writeHash();
    $<HTMLInputElement>('url').value = url;
    selectDataset(example);
    renderSummary();
    $('tab-compare').hidden = !(example && compaction && example.group.startsWith('Telraam LDES'));
    const tab = view.get('tab');
    selectTab(tab && document.querySelector<HTMLButtonElement>(`.tabs button[data-tab="${tab}"]:not([hidden])`) ? tab : 'chart');
    setStatus('');
    $('result').hidden = false;
    renderCode();
  } catch (error) {
    const message = (error as Error).message;
    setStatus(`${message}${/fetch|Failed|NetworkError/i.test(message) ? '\n(Fetching another site needs CORS headers: Access-Control-Allow-Origin: *.)' : ''}`, true);
  }
}

function renderSummary(): void {
  const { source, example, times } = state!;
  const m = source.metadata;
  $('title').textContent = m.labels[0] ?? example?.title ?? m.id;
  const bits = [`${m.kind} source`, `${times.length} rows`, `${m.fields.length - 1 - (m.stepField ? 1 : 0)} fields`];
  if (m.from) bits.push(`from ${m.from}`);
  if (m.until) bits.push(`until ${m.until}`);
  bits.push(m.immutable ? 'immutable' : 'growing: new rows may still arrive');
  $('subtitle').textContent = bits.join(' · ');
  $('description').textContent = example?.description ?? '';
}

function selectTab(name: string): void {
  setView({ tab: name === 'chart' ? undefined : name });
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tabs button')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) panel.hidden = panel.id !== `panel-${name}`;
  if (state && !state.rendered.has(name)) {
    state.rendered.add(name);
    const render = { chart: renderCharts, table: renderTable, metadata: renderMetadata, patterns: renderPatternsTab, messages: renderMessages, validate: renderValidate, compare: renderCompare }[name];
    void render?.().catch((error: Error) => {
      $(`panel-${name}`).textContent = error.message;
    });
  } else if (name === 'table') {
    void renderTable();
  }
}

/* ---------- chart ---------- */

function seriesOf(fields: FieldMetadata[]): Series[] {
  const { times, values } = state!;
  const number = (f: FieldMetadata | undefined, i: number) => {
    const text = f ? values.get(f.id)?.[i] : undefined;
    return text === undefined || Number.isNaN(Number(text)) ? null : Number(text);
  };
  return fields.map((f) => {
    const interval = intervalOf(f);
    return {
      name: label(f),
      // a standard uncertainty is one standard deviation either side of the value
      interval: interval?.uncertainty
        ? `standard uncertainty (±1σ, ${label(interval.uncertainty)})`
        : interval?.range
          ? `minimum and maximum (${label(interval.lower!)} to ${label(interval.upper!)})`
          : interval
            ? `error bounds (${label(interval.lower!)} to ${label(interval.upper!)})`
            : undefined,
      points: times.map((time, i) => {
        const v = number(f, i);
        if (v === null || !interval) return { t: Date.parse(time), v };
        if (interval.uncertainty) {
          const u = number(interval.uncertainty, i);
          return { t: Date.parse(time), v, lo: u === null ? null : v - u, hi: u === null ? null : v + u };
        }
        return { t: Date.parse(time), v, lo: number(interval.lower, i), hi: number(interval.upper, i) };
      }),
    };
  });
}

async function renderCharts(): Promise<void> {
  if (state!.source.metadata.fields.some((f) => f.unit)) await loadQudtUnits();
  const panel = $('panel-chart');
  panel.replaceChildren();
  const { source } = state!;
  const all = groups(source);
  if (all.size === 0) panel.textContent = 'This source has no numeric fields to chart.';
  let index = 0;
  // zooming in on one chart zooms the others to the same times
  const zoom = new ZoomGroup();
  // the zoom is part of the view: from and until, as times
  const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
  zoom.subscribe(() => setView({ from: zoom.view ? iso(zoom.view[0]) : undefined, until: zoom.view ? iso(zoom.view[1]) : undefined }));
  const restore: (() => void)[] = [];
  for (const [, fields] of all) {
    const section = document.createElement('div');
    section.className = 'chart';
    const head = document.createElement('div');
    head.className = 'chart-head';
    const title = document.createElement('h3');
    // fields that share a unit share a chart: its title names the first, the legend all of them
    const property = fields[0].observedProperty
      ? local(fields[0].observedProperty)
      : fields.length > 1
        ? `${label(fields[0])} and ${fields.length - 1} more`
        : label(fields[0]);
    const setTitle = (unit?: string) => (title.textContent = `${property}${unit ? ` (${symbol(unit)})` : ''}`);
    setTitle(fields[0].unit);
    head.append(title);
    const note = document.createElement('p');
    note.className = 'note';
    const area = document.createElement('div');
    let stopChart: (() => void) | undefined;

    // the units of the quantity kind, from QUDT
    const family = fields[0].unit ? unitChoices(fields[0], fields[0].unit) : [];
    const draw = () => {
      const lines = seriesOf(fields);
      const counts = !fields[0].unit && lines.every((s) => s.points.every((p) => p.v === null || (p.v >= 0 && Number.isInteger(p.v))));
      const unit = state!.unit.get(fields[0].id);
      stopChart?.();
      stopChart = renderChart(area, { series: lines, step: counts, zero: counts, unit: unit ? symbol(unit) : undefined, zoom });
      state!.stopCharts.push(stopChart);
    };
    if (fields[0].unit && convertible(fields[0].unit)) {
      const controls = document.createElement('div');
      controls.className = 'chart-controls';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Unit');
      const options: [string, string][] = [[fields[0].unit, `${symbol(fields[0].unit)} (as published)`]];
      for (const unit of family) if (unit !== fields[0].unit) options.push([unit, `${symbol(unit)}${qudtTable?.units[unit.slice(QUDT_UNIT.length)] ? ` (${qudtTable.units[unit.slice(QUDT_UNIT.length)][1]})` : ''}`]);
      options.push(['qudt', 'SI (QUDT normalized)']);
      for (const [value, text] of options) select.append(new Option(text, value));
      select.addEventListener('change', async () => {
        const unit = select.value;
        note.textContent = 'Converting with QUDT, by eyemind …';
        note.style.color = '';
        try {
          // the uncertainty or the bounds of a value are converted with it
          const converted = [...fields, ...intervalFields(fields)];
          const readings = await readAll(source, { fields: converted.map((f) => f.id), unit: unit === fields[0].unit ? 'source' : unit });
          for (const f of converted) {
            state!.values.set(f.id, readings.map((r) => r.get(f.id)?.value));
            state!.unit.set(f.id, readings.find((r) => r.get(f.id))?.get(f.id)?.unit ?? f.unit);
            state!.selectedUnit.set(f.id, unit);
          }
          const shown = state!.unit.get(fields[0].id);
          setTitle(shown);
          note.textContent = unit === fields[0].unit ? '' : `Converted from ${symbol(fields[0].unit)} to ${symbol(shown)} with the QUDT unit catalog of eyemind. Values are numbers (double precision), no longer the exact published text.`;
          draw();
          renderCode();
          if (!$('panel-table').hidden) void renderTable();
        } catch (error) {
          note.textContent = error instanceof UnitConversionError ? error.message : (error as Error).message;
          note.style.color = 'var(--bad)';
        }
      });
      // the unit is part of the view, by the first field of the chart
      const key = `unit.${fields[0].localName}`;
      select.addEventListener('change', () => setView({ [key]: select.value === fields[0].unit ? undefined : unitParam(select.value) }));
      const linked = view.get(key);
      if (linked && [...select.options].some((o) => o.value === unitOfParam(linked))) {
        restore.push(() => {
          select.value = unitOfParam(linked);
          select.dispatchEvent(new Event('change'));
        });
      }
      const caption = document.createElement('label');
      caption.textContent = 'Unit ';
      caption.append(select);
      controls.append(caption);
      head.append(controls);
    }
    section.append(head, note, area);
    panel.append(section);
    draw();
    index++;
  }
  for (const apply of restore) apply();
  const [from, until] = [Date.parse(view.get('from') ?? ''), Date.parse(view.get('until') ?? '')];
  if (from < until) zoom.set([from, until]);
  if (index > 0 && [...all.values()].some((fields) => convertible(fields[0].unit))) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Change the unit of a chart: the readings are converted with QUDT, thanks to eyemind, while they are read.';
    panel.prepend(hint);
  }
}

/* ---------- patterns ---------- */

async function renderPatternsTab(): Promise<void> {
  const current = state!;
  const { timeField, stepField } = current.source.metadata;
  const fields = current.source.metadata.fields
    .filter((f) => f.id !== timeField && f.id !== stepField && isNumeric(f))
    .map((f) => ({ id: f.id, label: label(f), unit: current.unit.get(f.id) }));
  // the field by its local name in the view
  const byName = new Map(current.source.metadata.fields.map((f) => [f.localName, f.id]));
  const initial = {
    field: byName.get(view.get('field') ?? ''),
    period: view.get('period') ?? undefined,
    window: view.get('window') ?? undefined,
    shift: view.get('shift') ?? undefined,
    gaps: view.get('gaps') ?? undefined,
  };
  const onChange = (s: { field: string; period: string; window: string; shift: string; gaps: string }) =>
    setView({ field: current.source.resolveField(s.field).localName, period: s.period, window: s.window, shift: s.shift, gaps: s.gaps });
  current.stopCharts.push(renderPatterns($('panel-patterns'), { fields, times: current.times, values: (id) => current.values.get(id)!, symbol, initial, onChange }));
}

/* ---------- table ---------- */

async function renderTable(): Promise<void> {
  const { source, times, values, unit } = state!;
  const m = source.metadata;
  const fields = m.fields.filter((f) => f.id !== m.timeField && f.id !== m.stepField);
  const panel = $('panel-table');
  const limit = 500;
  const head = fields.map((f) => `<th title="${esc(f.id)}">${esc(label(f))}${unit.get(f.id) ? `<br><small>${esc(symbol(unit.get(f.id)))}</small>` : ''}</th>`).join('');
  const rows = times.slice(0, limit).map(
    (time, i) => `<tr><td>${esc(time)}</td>${fields.map((f) => {
      const v = values.get(f.id)![i];
      return v === undefined ? '<td class="empty">–</td>' : `<td>${esc(v)}</td>`;
    }).join('')}</tr>`,
  );
  panel.innerHTML = `<p class="muted">${times.length} rows${times.length > limit ? `, the first ${limit} shown` : ''}. A dash is no value. Values are the exact published text, unless you chose another unit.</p>
    <div style="max-height:32rem;overflow:auto"><table><thead><tr><th>time</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/* ---------- metadata ---------- */

async function renderMetadata(): Promise<void> {
  const { source } = state!;
  const turtle = await serializeRdf([...source.dataset], 'text/turtle', PREFIXES);
  const panel = $('panel-metadata');
  panel.innerHTML = `<p class="muted">The RDF that describes the source${source.kind.startsWith('Embedded') ? ', with the embedded points' : ''}: ${new TextEncoder().encode(turtle).length} bytes as Turtle.</p><pre>${highlightTurtle(turtle)}</pre>`;
}

/* ---------- RDF messages ---------- */

/** The prefixes of `PREFIXES` that these quads use. */
function usedPrefixes(quads: { subject: { value: string }; predicate: { value: string }; object: { value: string; termType: string; datatype?: { value: string } } }[]): Record<string, string> {
  const iris = new Set<string>();
  for (const q of quads) {
    iris.add(q.subject.value);
    // rdf:type is written as `a`
    if (q.predicate.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') iris.add(q.predicate.value);
    if (q.object.termType === 'NamedNode') iris.add(q.object.value);
    if (q.object.datatype) iris.add(q.object.datatype.value);
  }
  return Object.fromEntries(Object.entries(PREFIXES).filter(([, ns]) => [...iris].some((iri) => iri.startsWith(ns) && iri.length > ns.length)));
}

/**
 * Messages as one RDF Message Log, as the specification writes it: the version label and the
 * prefixes once, every message in Turtle, a `MESSAGE` delimiter after each, and before each a
 * comment that says what it holds.
 */
async function messageLog(messages: { quads: RDFMessage['quads']; comment: string }[]): Promise<string> {
  const prefixes = usedPrefixes(messages.flatMap((m) => m.quads) as never);
  const head = ['VERSION "1.2-messages"', ...Object.entries(prefixes).map(([name, ns]) => `PREFIX ${name}: <${ns}>`)].join('\n');
  const bodies = await Promise.all(
    messages.map(async (m) => {
      const turtle = await serializeRdf(m.quads, 'text/turtle', prefixes);
      // the prefixes are declared once, at the top
      return `# ${m.comment}\n${turtle.replace(/^@prefix[^\n]*\n/gm, '').trim()}\nMESSAGE`;
    }),
  );
  return `${head}\n\n${bodies.join('\n')}\n`;
}

async function renderMessages(): Promise<void> {
  const panel = $('panel-messages');
  panel.innerHTML = `<div class="toolbar">
    <label>Rows <input id="msg-count" type="number" min="1" max="50" value="3" style="width:4rem"></label>
    <label>Also write what a reasoner derives <select id="msg-align"><option value="">nothing</option><option value="sosa">SOSA observations</option><option value="saref">SAREF measurements</option></select></label>
  </div><div id="msg-out"></div>`;
  // the choices of a link
  const rowsInView = Number(view.get('rows'));
  if (Number.isInteger(rowsInView) && rowsInView >= 1 && rowsInView <= 50) $<HTMLInputElement>('msg-count').value = String(rowsInView);
  const alignInView = view.get('align');
  if (alignInView === 'sosa' || alignInView === 'saref') $<HTMLSelectElement>('msg-align').value = alignInView;
  const run = async () => {
    const count = Number($<HTMLInputElement>('msg-count').value) || 3;
    const align = $<HTMLSelectElement>('msg-align').value as '' | 'sosa' | 'saref';
    setView({ rows: count === 3 ? undefined : String(count), align: align || undefined });
    const out = $('msg-out');
    out.textContent = 'Working …';
    try {
      const messages: { quads: RDFMessage['quads']; comment: string }[] = [];
      let points = 0;
      let index = 0;
      let rows = 0;
      const started = performance.now();
      const options = align ? { align, aligner: await loadAligner() } : {};
      const loaded = performance.now() - started;
      // the first row message also prepares the reasoner: the background is closed once
      let prepared = 0;
      let reasoned = 0;
      let rowTime = 0;
      let last = performance.now();
      for await (const message of state!.source.expand(options)) {
        if (align && index === 1) prepared = performance.now() - last;
        else if (align && index > 1) {
          rowTime += performance.now() - last;
          reasoned++;
        }
        index++;
        const rowPoints = message.quads.filter((q) => q.predicate.value === 'https://w3id.org/tss#hasPoint').length;
        points += rowPoints;
        if (index > 1 && rowPoints > 0) rows++;
        const time = message.quads.find((q) => q.predicate.value === 'https://w3id.org/tss#time')?.object.value;
        const comment =
          index === 1
            ? 'the metadata: the description of the source and its fields'
            : rowPoints > 0
              ? `row ${rows}: ${time}, ${rowPoints} point${rowPoints === 1 ? '' : 's'}`
              : 'the ending: tss:immutable true and the stored summaries';
        messages.push({ quads: message.quads, comment });
        if (index > count) break;
        last = performance.now();
      }
      const derivedNote = align
        ? `<p class="muted">With <b>${align === 'sosa' ? 'SOSA observations' : 'SAREF measurements'}</b>, the triples about each point other than <code>tss:</code> ones are derived in your browser by a reasoner, <a href="https://github.com/eyereasoner/eyemind">eyemind</a> with its OWL 2 RL profile, from the <a href="${TSS_VOCABULARY_SOURCE}">TSS vocabulary of the specification</a> and the description of the source: the library itself writes none of them. The rules are specialized to the shape of the points and to the observations asked for (SHACL in and out shapes), so the background is closed once: ${Math.round(loaded)} ms to load the reasoner, ${Math.round(prepared)} ms to prepare it with the first row${reasoned ? `, then ${(rowTime / reasoned).toFixed(1)} ms for each next row` : ''}.</p>`
        : '';
      out.innerHTML = `<p class="muted">The expansion of the source into points, as one RDF Message Log: the first message is the metadata, with the default property of each describing field that states no <code>tss:property</code>; each next message holds one row, with a point for every value of a value field (${points} points in ${rows} rows here), which states its field, time and reading with <code>tss:field</code>, <code>tss:time</code> and <code>tss:value</code>; an immutable source ends with a message with <code>tss:immutable true</code> and the stored summaries. These are the three kinds of messages of the RDF Message Stream Profile of the specification, each ended by <code>MESSAGE</code>. A source is a table; an RDF Message Log is a stream of small RDF documents: this turns one into the other.</p>${derivedNote}<pre class="messages">${highlightTurtle(await messageLog(messages))}</pre>`;
    } catch (error) {
      out.textContent = (error as Error).message;
    }
  };
  for (const id of ['msg-count', 'msg-align']) $(id).addEventListener('change', () => void run());
  await run();
}

/* ---------- validate ---------- */

async function renderValidate(): Promise<void> {
  const panel = $('panel-validate');
  panel.textContent = 'Checking …';
  const report = await state!.source.validate();
  if (report.conforms) {
    panel.innerHTML = '<p><span class="badge good">conforms</span> The metadata and the data meet every rule of the specification this library checks.</p>';
    return;
  }
  panel.innerHTML = `<p><span class="badge bad">${report.results.length} findings</span></p><table class="findings"><thead><tr><th>Rule</th><th>Where</th><th>Finding</th></tr></thead><tbody>${report.results
    .map((r) => `<tr><td>${esc(r.rule)}</td><td>${esc([r.node ? local(r.node) : '', r.row ? `row ${r.row}` : ''].filter(Boolean).join(', '))}</td><td>${esc(r.message)}</td></tr>`)
    .join('')}</tbody></table>`;
}

/* ---------- compared to the LDES ---------- */

async function gzipSize(data: Uint8Array): Promise<number | undefined> {
  if (typeof CompressionStream === 'undefined') return undefined;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

async function renderCompare(): Promise<void> {
  const panel = $('panel-compare');
  panel.textContent = 'Measuring …';
  const { source, url, times } = state!;
  const id = url.match(/telraam\/(\d+)/)?.[1];
  const entry = compaction!.locations.find((l) => l.id === id);
  if (!entry) {
    panel.textContent = 'Open one of the Telraam examples to compare it with the LDES.';
    return;
  }
  const metadataBytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const dataIri = source.dataFileIri();
  const dataBytes = new Uint8Array(await (await fetch(dataIri)).arrayBuffer());
  const total = metadataBytes.length + dataBytes.length;
  const metadataGz = (await gzipSize(metadataBytes)) ?? 0;
  const dataGz = (await gzipSize(dataBytes)) ?? 0;
  const gz = metadataGz + dataGz;
  const ldes = entry.ldes;
  const days = 30;
  // the metadata is written once; the rows grow with the days
  const projectedLdes = ldes.bytes * days;
  const projectedTss = metadataBytes.length + dataBytes.length * days;
  const projectedLdesGz = ldes.gzip * days;
  const projectedTssGz = metadataGz + dataGz * days;
  const bar = (value: number, max: number, kind: 'ldes' | 'tss', text: string) =>
    `<div class="bar ${kind}"><span style="width:${Math.max(0.5, (value / max) * 100)}%"></span></div><span>${text}</span>`;
  const row = (name: string, a: number, b: number, max: number) =>
    `<div class="bar-row"><span>${name} LDES</span>${bar(a, max, 'ldes', fmtBytes(a))}</div><div class="bar-row"><span>${name} RDF-TSS</span>${bar(b, max, 'tss', fmtBytes(b))}</div>`;

  const sample = await (await fetch(new URL('examples/telraam/sample-members.ttl', location.href))).text();
  const csvText = new TextDecoder().decode(dataBytes);
  const csvHead = source.kind === 'CSV' ? csvText.split('\n').slice(0, 4).join('\n') : '(a binary file: open the CSV example to see its rows)';
  const memberLines = sample.split('\n').filter((l) => !l.startsWith('@prefix')).join('\n').trim();

  panel.innerHTML = `
    <p>The <a href="https://ldes.telraam-api.net/measurements">Telraam LDES</a> publishes every hourly count of every series as a member of about 25 triples.
       In RDF-TSS the counts of one location share a time, so they fit one table, described once.
       Below, the <strong>${ldes.members} members</strong> of location ${esc(entry.id)} on ${esc(compaction!.day)} next to the one source that holds the same ${times.length} × 8 counts
       (<a href="examples/telraam/ldes-members.ttl">download all ${compaction!.members} LDES members of the sample</a>, to check).</p>
    <div class="facts">
      <div><div class="big">${fmtRatio(ldes.bytes / total)}×<small> smaller</small></div>as Turtle + CSV</div>
      <div><div class="big">${gz ? fmtRatio(ldes.gzip / gz) + '×' : '–'}<small> smaller</small></div>when gzipped</div>
      <div><div class="big">${fmtRatio((projectedLdes / projectedTss))}×<small> smaller</small></div>after ${days} days (projected)</div>
    </div>
    <div class="bars">
      <h3>One day, ${times.length} hourly rows</h3>
      ${row('Turtle', ldes.bytes, total, ldes.bytes)}
      ${row('gzipped', ldes.gzip, gz, ldes.gzip)}
      <h3>${days} days (projected: the metadata is written once, the rows grow)</h3>
      ${row('Turtle', projectedLdes, projectedTss, projectedLdes)}
      ${row('gzipped', projectedLdesGz, projectedTssGz, projectedLdesGz)}
    </div>
    <p class="muted">RDF-TSS here is ${fmtBytes(metadataBytes.length)} of metadata (with a stored summary of every series) plus ${fmtBytes(dataBytes.length)} of ${esc(source.kind)} data, as served to this page.
       The LDES figure is the members alone, as compact Turtle: the real pages repeat prefixes and add hypermedia controls. A time grid (<code>tss:timeBase</code>, <code>tss:timeStep</code>) would also drop the time column.</p>
    <div class="compare-grid">
      <div><h3>Two LDES members</h3><pre>${esc(memberLines)}</pre></div>
      <div><h3>The same information in the source's data file</h3><pre>${esc(csvHead)}</pre>
        <p class="muted">Each column says what it observes in the metadata: <code>tss:observedProperty</code>, the feature of interest, the sensor, the vehicle type and the direction. The RDF Messages tab turns every cell back into a point, which a reasoner reads as a SOSA observation.</p></div>
    </div>`;
}

/* ---------- code ---------- */

function renderCode(): void {
  const { url, source, selectedUnit } = state!;
  const fields = source.metadata.fields;
  const first = fields.find((f) => f.id !== source.metadata.timeField && f.id !== source.metadata.stepField);
  // the units chosen in the charts, per field: fields have different dimensions
  const chosen = fields.filter((f) => selectedUnit.get(f.id) && selectedUnit.get(f.id) !== f.unit);
  const quote = (unit: string) => (unit === 'qudt' ? "'qudt'" : unit.startsWith(QUDT_UNIT) ? `unit('${unit.slice(QUDT_UNIT.length)}')` : `'${unit}'`);
  const options = chosen.length ? `{ unit: { ${chosen.map((f) => `${/^[A-Za-z_]\w*$/.test(f.localName) ? f.localName : `'${f.localName}'`}: ${quote(selectedUnit.get(f.id)!)}`).join(', ')} } }` : '';
  const helper = chosen.some((f) => selectedUnit.get(f.id)!.startsWith(QUDT_UNIT)) ? `const unit = (name: string) => '${QUDT_UNIT}' + name;\n\n` : '';
  const shown = chosen[0] ?? first;
  $('code').textContent = `import { Source } from 'rdf-tss';

${helper}const source = await Source.fetch('${url}');

for await (const row of source.read(${options})) {
  console.log(row.time, row.get('${shown?.localName ?? 'field'}')?.value);
}

// and expanded into points, as RDF Messages: the metadata, then one message per row
for await (const message of source.expand()) {
  publish(message);
}`;
}

/* ---------- start ---------- */

const CUSTOM = '__custom__';
const exampleUrl = (example: Example) => new URL(`examples/${example.metadata}`, location.href).href;

/** A drop-down with the examples, grouped by category, and a custom URL. */
/** The selects of the menu: a publisher (or your own URL), a dataset, and a series. */
const levels = () => [$<HTMLSelectElement>('dataset'), $<HTMLSelectElement>('dataset-2'), $<HTMLSelectElement>('dataset-3')];

/** The examples under the first `depth` choices of the menu. */
const under = (choices: string[]) => examples.filter((e) => choices.every((c, i) => e.path[i] === c));
const distinct = (list: string[]) => [...new Set(list)];

/** Fill the select of level `depth` (1 or 2) with what lies under the choices before it, and choose `value`. */
function fillLevel(depth: number, value?: string): void {
  const select = levels()[depth];
  const choices = levels().slice(0, depth).map((s) => s.value);
  const below = under(choices).filter((e) => e.path.length > depth);
  const names = distinct(below.map((e) => e.path[depth]));
  select.replaceChildren(...names.map((name) => new Option(name, name)));
  // a dataset of one series ends the menu: there is nothing to choose below it
  select.hidden = names.length === 0 || (depth === 2 && names.length === 1 && below[0].path.length === 3 && below[0].path[2] === below[0].path[1]);
  if (value && names.includes(value)) select.value = value;
  for (const deeper of levels().slice(depth + 1)) deeper.hidden = true;
}

/** The example the menu points at: the first under the choices of the visible selects. */
function chosenExample(): Example | undefined {
  const choices = levels().filter((s) => !s.hidden).map((s) => s.value);
  return under(choices)[0];
}

function renderExamples(): void {
  const [first, second, third] = levels();
  first.replaceChildren(new Option('Your own URL …', CUSTOM), ...distinct(examples.map((e) => e.path[0])).map((name) => new Option(name, name)));
  const openChosen = () => {
    const example = chosenExample();
    if (example) void open(exampleUrl(example), example);
  };
  first.addEventListener('change', () => {
    if (first.value === CUSTOM) {
      second.hidden = third.hidden = true;
      showCustom(true);
      $<HTMLInputElement>('url').focus();
      return;
    }
    showCustom(false);
    fillLevel(1);
    if (!second.hidden && under([first.value, second.value]).some((e) => e.path.length > 2)) fillLevel(2);
    openChosen();
  });
  second.addEventListener('change', () => {
    if (under([first.value, second.value]).some((e) => e.path.length > 2)) fillLevel(2);
    else third.hidden = true;
    openChosen();
  });
  third.addEventListener('change', openChosen);
}

function showCustom(visible: boolean): void {
  $('url-form').hidden = !visible;
  if (visible) $('dataset-note').textContent = 'Paste the URL of the metadata of a source, in any RDF syntax. A server on another site needs CORS headers (Access-Control-Allow-Origin: *).';
}

/** Show the example, or the custom URL, in the menu. */
function selectDataset(example?: Example): void {
  const [first, second, third] = levels();
  showCustom(!example);
  if (!example) {
    first.value = CUSTOM;
    second.hidden = third.hidden = true;
    return;
  }
  first.value = example.path[0];
  fillLevel(1, example.path[1]);
  if (example.path.length > 2) fillLevel(2, example.path[2]);
  $('dataset-note').textContent = example.description;
}

async function start(): Promise<void> {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tabs button')) tab.addEventListener('click', () => selectTab(tab.dataset.tab!));
  $('url-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const url = $<HTMLInputElement>('url').value.trim();
    if (url) {
      const absolute = new URL(url, location.href).href;
      void open(absolute, examples.find((e) => exampleUrl(e) === absolute));
    }
  });
  try {
    examples = await (await fetch('examples/index.json')).json();
    compaction = await (await fetch('examples/telraam/compaction.json')).json();
  } catch {
    setStatus('The examples are not available; paste the URL of a source above.');
  }
  renderExamples();
  // a hash the reader changes, such as a link pasted in the address bar, opens its view
  window.addEventListener('hashchange', () => void openHash());
  if (!(await openHash()) && examples[0]) await open(exampleUrl(examples[0]), examples[0]);
}

/** Open the dataset and the view of the hash; `false` when the hash names no dataset. */
async function openHash(): Promise<boolean> {
  const { dataset, params } = datasetOfHash();
  const example = examples.find((e) => e.id === dataset);
  if (example) await open(exampleUrl(example), example, params);
  else if (/^https?:/.test(dataset)) await open(dataset, undefined, params);
  else return false;
  return true;
}

void start();
