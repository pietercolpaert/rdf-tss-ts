import {
  Snippet,
  UnitConversionError,
  createEyemindUnitConverter,
  serializeRdf,
  toRDFMessages,
  type FieldMetadata,
  type ReadableSnippet,
  type Reading,
  type UnitConverter,
} from '../src/index.js';
import { renderChart, type Series } from './chart.js';

interface Example {
  id: string;
  title: string;
  group: string;
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
    snippet: Record<string, { metadata: number; data: number; total: number; gzip: number }>;
  }[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SYMBOLS: Record<string, string> = {
  DEG_C: '°C', DEG_F: '°F', K: 'K', PERCENT: '%', UNITLESS: '1', 'KiloM-PER-HR': 'km/h', 'M-PER-SEC': 'm/s', 'MI-PER-HR': 'mph', KN: 'kn',
  KiloPA: 'kPa', PA: 'Pa', BAR: 'bar', M: 'm', KiloM: 'km', CentiM: 'cm', MilliM: 'mm', IN: 'in', FT: 'ft', MI: 'mi', SEC: 's', MIN: 'min', HR: 'h', DAY: 'd',
  KiloGM: 'kg', GM: 'g', LB: 'lb', J: 'J', KiloJ: 'kJ', W: 'W', KiloW: 'kW', L: 'L', MilliL: 'mL', M2: 'm²', M3: 'm³',
};
const FAMILIES = [
  ['DEG_C', 'DEG_F', 'K'],
  ['KiloM-PER-HR', 'M-PER-SEC', 'MI-PER-HR', 'KN'],
  ['KiloPA', 'PA', 'BAR'],
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
  async conversion(from, to) {
    // @ts-expect-error resolved by the bundler: the command line entry of eyemind, which has the QUDT profile
    converter ??= createEyemindUnitConverter({ main: (await import('eyemind-cli')).main });
    return converter.conversion(from, to);
  },
};

interface State {
  url: string;
  example?: Example;
  snippet: ReadableSnippet;
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

const symbol = (iri?: string) => (iri ? (SYMBOLS[iri.replace(QUDT_UNIT, '')] ?? iri.replace(QUDT_UNIT, '')) : '');
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

async function readAll(snippet: ReadableSnippet, options: { fields?: string[]; unit?: string } = {}): Promise<Reading[]> {
  const out: Reading[] = [];
  for await (const reading of snippet.read(options)) out.push(reading);
  return out;
}

const isNumeric = (f: FieldMetadata) => /#(double|float|decimal|integer|long|int|short|byte|nonNegativeInteger|positiveInteger|unsigned\w+)$/.test(f.datatype);

/** Fields with the same property and unit share a chart. */
function groups(snippet: ReadableSnippet): Map<string, FieldMetadata[]> {
  const { timeField, stepField } = snippet.metadata;
  const out = new Map<string, FieldMetadata[]>();
  for (const f of snippet.metadata.fields) {
    if (f.id === timeField || f.id === stepField || !isNumeric(f)) continue;
    const key = f.observedProperty || f.unit ? `${f.observedProperty ?? ''}|${f.unit ?? ''}` : f.id;
    out.set(key, [...(out.get(key) ?? []), f]);
  }
  return out;
}

function familyOf(unit?: string): string[] | undefined {
  const name = unit?.replace(QUDT_UNIT, '');
  return FAMILIES.find((family) => name && family.includes(name))?.map((n) => QUDT_UNIT + n);
}

async function open(url: string, example?: Example): Promise<void> {
  setStatus(`Fetching ${url} …`);
  $('result').hidden = true;
  for (const stop of state?.stopCharts ?? []) stop();
  try {
    const snippet = await Snippet.fetch(url, { unitConverter: lazyConverter });
    const readings = await readAll(snippet);
    const values = new Map<string, (string | undefined)[]>();
    const unit = new Map<string, string | undefined>();
    for (const f of snippet.metadata.fields) {
      values.set(f.id, readings.map((r) => r.get(f.id)?.value));
      unit.set(f.id, f.unit);
    }
    state = { url, example, snippet, times: readings.map((r) => r.time), values, unit, selectedUnit: new Map(), rendered: new Set(), stopCharts: [] };
    history.replaceState(null, '', `#${example ? example.id : encodeURIComponent(url)}`);
    $<HTMLInputElement>('url').value = url;
    selectDataset(example);
    renderSummary();
    $('tab-compare').hidden = !(example && compaction && example.group.startsWith('Telraam LDES'));
    selectTab('chart');
    setStatus('');
    $('result').hidden = false;
    renderCode();
  } catch (error) {
    const message = (error as Error).message;
    setStatus(`${message}${/fetch|Failed|NetworkError/i.test(message) ? '\n(Fetching another site needs CORS headers: Access-Control-Allow-Origin: *.)' : ''}`, true);
  }
}

function renderSummary(): void {
  const { snippet, example, times } = state!;
  const m = snippet.metadata;
  $('title').textContent = m.labels[0] ?? example?.title ?? m.id;
  const bits = [`${m.kind} snippet`, `${times.length} readings`, `${m.fields.length - 1 - (m.stepField ? 1 : 0)} fields`];
  if (m.from) bits.push(`from ${m.from}`);
  if (m.until) bits.push(`until ${m.until}`);
  bits.push(m.immutable ? 'immutable' : 'growing: new readings may still arrive');
  $('subtitle').textContent = bits.join(' · ');
  $('description').textContent = example?.description ?? '';
}

function selectTab(name: string): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tabs button')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) panel.hidden = panel.id !== `panel-${name}`;
  if (state && !state.rendered.has(name)) {
    state.rendered.add(name);
    const render = { chart: renderCharts, table: renderTable, metadata: renderMetadata, messages: renderMessages, validate: renderValidate, compare: renderCompare }[name];
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
  return fields.map((f) => ({
    name: label(f),
    points: times.map((time, i) => {
      const text = values.get(f.id)![i];
      return { t: Date.parse(time), v: text === undefined || Number.isNaN(Number(text)) ? null : Number(text) };
    }),
  }));
}

async function renderCharts(): Promise<void> {
  const panel = $('panel-chart');
  panel.replaceChildren();
  const { snippet } = state!;
  const all = groups(snippet);
  if (all.size === 0) panel.textContent = 'This snippet has no numeric fields to chart.';
  let index = 0;
  for (const [, fields] of all) {
    const section = document.createElement('div');
    section.className = 'chart';
    const head = document.createElement('div');
    head.className = 'chart-head';
    const title = document.createElement('h3');
    const property = fields[0].observedProperty ? local(fields[0].observedProperty) : label(fields[0]);
    const setTitle = (unit?: string) => (title.textContent = `${property}${unit ? ` (${symbol(unit)})` : ''}`);
    setTitle(fields[0].unit);
    head.append(title);
    const note = document.createElement('p');
    note.className = 'note';
    const area = document.createElement('div');
    let stopChart: (() => void) | undefined;

    const family = familyOf(fields[0].unit);
    const draw = () => {
      const lines = seriesOf(fields);
      const counts = !fields[0].unit && lines.every((s) => s.points.every((p) => p.v === null || (p.v >= 0 && Number.isInteger(p.v))));
      const unit = state!.unit.get(fields[0].id);
      stopChart?.();
      stopChart = renderChart(area, { series: lines, step: counts, zero: counts, unit: unit ? symbol(unit) : undefined });
      state!.stopCharts.push(stopChart);
    };
    if (fields[0].unit) {
      const controls = document.createElement('div');
      controls.className = 'chart-controls';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Unit');
      const options: [string, string][] = [[fields[0].unit, `${symbol(fields[0].unit)} (as published)`]];
      for (const unit of family ?? []) if (unit !== fields[0].unit) options.push([unit, symbol(unit)]);
      options.push(['qudt', 'SI (QUDT normalized)']);
      for (const [value, text] of options) select.append(new Option(text, value));
      select.addEventListener('change', async () => {
        const unit = select.value;
        note.textContent = 'Converting with QUDT, by eyemind …';
        note.style.color = '';
        try {
          const readings = await readAll(snippet, { fields: fields.map((f) => f.id), unit: unit === fields[0].unit ? 'source' : unit });
          for (const f of fields) {
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
  if (index > 0 && [...all.values()].some((fields) => fields[0].unit)) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Change the unit of a chart: the readings are converted with QUDT, thanks to eyemind, while they are read.';
    panel.prepend(hint);
  }
}

/* ---------- table ---------- */

async function renderTable(): Promise<void> {
  const { snippet, times, values, unit } = state!;
  const m = snippet.metadata;
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
  panel.innerHTML = `<p class="muted">${times.length} readings${times.length > limit ? `, the first ${limit} shown` : ''}. A dash is no value. Values are the exact published text, unless you chose another unit.</p>
    <div style="max-height:32rem;overflow:auto"><table><thead><tr><th>time</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/* ---------- metadata ---------- */

async function renderMetadata(): Promise<void> {
  const { snippet } = state!;
  const turtle = await serializeRdf([...snippet.dataset], 'text/turtle', PREFIXES);
  const panel = $('panel-metadata');
  panel.innerHTML = `<p class="muted">The RDF that describes the snippet${snippet.kind.startsWith('Embedded') ? ', with the embedded points' : ''}: ${new TextEncoder().encode(turtle).length} bytes as Turtle.</p><pre>${esc(turtle)}</pre>`;
}

/* ---------- RDF messages ---------- */

async function renderMessages(): Promise<void> {
  const panel = $('panel-messages');
  panel.innerHTML = `<div class="toolbar">
    <label>Readings <input id="msg-count" type="number" min="1" max="50" value="3" style="width:4rem"></label>
    <label>Unit <select id="msg-unit"><option value="source">as published</option><option value="qudt">QUDT normalized (SI)</option></select></label>
    <label>Description of sensors, properties, … <select id="msg-description"><option value="first">in the first message</option><option value="every">in every message</option><option value="none">left out</option></select></label>
  </div><div id="msg-out"></div>`;
  const run = async () => {
    const count = Number($<HTMLInputElement>('msg-count').value) || 3;
    const unit = $<HTMLSelectElement>('msg-unit').value;
    const description = $<HTMLSelectElement>('msg-description').value as 'first' | 'every' | 'none';
    const out = $('msg-out');
    out.textContent = 'Working …';
    try {
      const readings: Reading[] = [];
      for await (const r of state!.snippet.read({ unit })) {
        readings.push(r);
        if (readings.length >= count) break;
      }
      const parts: string[] = [];
      let observations = 0;
      let index = 0;
      async function* limited() {
        yield* readings;
      }
      for await (const message of toRDFMessages(limited(), { description })) {
        index++;
        observations += message.quads.filter((q) => q.predicate.value.endsWith('observedProperty')).length;
        const text = await message.serialize('text/turtle', PREFIXES);
        parts.push(`<div class="message"><h4>Message ${index}</h4><pre>${esc(text)}</pre></div>`);
      }
      out.innerHTML = `<p class="muted">${readings.length} readings give ${observations} observations in ${index} messages: one observation for every value of a field that has an <code>tss:observedProperty</code>. A snippet is a table; an RDF Message log is a stream of small RDF documents: this turns one into the other.</p>${parts.join('') || '<p>No field of this snippet has a tss:observedProperty, so there are no observations.</p>'}`;
    } catch (error) {
      out.textContent = (error as Error).message;
    }
  };
  for (const id of ['msg-count', 'msg-unit', 'msg-description']) $(id).addEventListener('change', () => void run());
  await run();
}

/* ---------- validate ---------- */

async function renderValidate(): Promise<void> {
  const panel = $('panel-validate');
  panel.textContent = 'Checking …';
  const report = await state!.snippet.validate();
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
  const { snippet, url, times } = state!;
  const id = url.match(/telraam\/(\d+)/)?.[1];
  const entry = compaction!.locations.find((l) => l.id === id);
  if (!entry) {
    panel.textContent = 'Open one of the Telraam examples to compare it with the LDES.';
    return;
  }
  const metadataBytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const dataIri = snippet.dataFileIri();
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
  const csvHead = snippet.kind === 'CSV' ? csvText.split('\n').slice(0, 4).join('\n') : '(a binary file: open the CSV example to see its rows)';
  const memberLines = sample.split('\n').filter((l) => !l.startsWith('@prefix')).join('\n').trim();

  panel.innerHTML = `
    <p>The <a href="https://ldes.telraam-api.net/measurements">Telraam LDES</a> publishes every hourly count of every series as a member of about 25 triples.
       In RDF-TSS the counts of one location share a time, so they fit one table, described once.
       Below, the <strong>${ldes.members} members</strong> of location ${esc(entry.id)} on ${esc(compaction!.day)} next to the one snippet that holds the same ${times.length} × 8 counts
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
    <p class="muted">RDF-TSS here is ${fmtBytes(metadataBytes.length)} of metadata (with a stored summary of every series) plus ${fmtBytes(dataBytes.length)} of ${esc(snippet.kind)} data, as served to this page.
       The LDES figure is the members alone, as compact Turtle: the real pages repeat prefixes and add hypermedia controls. A time grid (<code>tss:timeBase</code>, <code>tss:timeStep</code>) would also drop the time column.</p>
    <div class="compare-grid">
      <div><h3>Two LDES members</h3><pre>${esc(memberLines)}</pre></div>
      <div><h3>The same information in the snippet's data file</h3><pre>${esc(csvHead)}</pre>
        <p class="muted">Each column says what it observes in the metadata: <code>tss:observedProperty</code>, the feature of interest, the sensor, the vehicle type and the direction. The RDF Messages tab turns every cell back into a SOSA observation.</p></div>
    </div>`;
}

/* ---------- code ---------- */

function renderCode(): void {
  const { url, snippet, selectedUnit } = state!;
  const first = snippet.metadata.fields.find((f) => f.id !== snippet.metadata.timeField && f.id !== snippet.metadata.stepField);
  const unit = [...selectedUnit.values()].find((u) => u);
  const absolute = url;
  $('code').textContent = `import { Snippet, toRDFMessages } from 'rdf-tss';

const snippet = await Snippet.fetch('${absolute}');

for await (const reading of snippet.read(${unit ? `{ unit: '${unit === 'qudt' ? 'qudt' : unit}' }` : ''})) {
  console.log(reading.time, reading.get('${first?.localName ?? 'field'}')?.value);
}

// and as RDF Messages
for await (const message of toRDFMessages(snippet.read(${unit ? `{ unit: '${unit}' }` : ''}))) {
  publish(message);
}`;
}

/* ---------- start ---------- */

const CUSTOM = '__custom__';
const exampleUrl = (example: Example) => new URL(`examples/${example.metadata}`, location.href).href;

/** A drop-down with the examples, grouped by category, and a custom URL. */
function renderExamples(): void {
  const select = $<HTMLSelectElement>('dataset');
  select.replaceChildren();
  for (const group of [...new Set(examples.map((e) => e.group))]) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const example of examples.filter((e) => e.group === group)) {
      const option = new Option(example.title, example.id);
      option.title = example.description;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
  const custom = document.createElement('optgroup');
  custom.label = 'Your own data';
  custom.append(new Option('Another URL …', CUSTOM));
  select.append(custom);
  select.addEventListener('change', () => {
    if (select.value === CUSTOM) {
      showCustom(true);
      $<HTMLInputElement>('url').focus();
      return;
    }
    showCustom(false);
    const example = examples.find((e) => e.id === select.value)!;
    void open(exampleUrl(example), example);
  });
}

function showCustom(visible: boolean): void {
  $('url-form').hidden = !visible;
  if (visible) $('dataset-note').textContent = 'Paste the URL of the metadata of a snippet, in any RDF syntax. A server on another site needs CORS headers (Access-Control-Allow-Origin: *).';
}

/** Show the example, or the custom URL, in the drop-down. */
function selectDataset(example?: Example): void {
  const select = $<HTMLSelectElement>('dataset');
  select.value = example ? example.id : CUSTOM;
  showCustom(!example);
  if (example) $('dataset-note').textContent = example.description;
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
    setStatus('The examples are not available; paste the URL of a snippet above.');
  }
  renderExamples();
  const hash = decodeURIComponent(location.hash.slice(1));
  const fromHash = examples.find((e) => e.id === hash);
  if (fromHash) await open(exampleUrl(fromHash), fromHash);
  else if (/^https?:/.test(hash)) await open(hash);
  else if (examples[0]) await open(exampleUrl(examples[0]), examples[0]);
}

void start();
