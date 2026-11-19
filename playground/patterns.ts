/**
 * The Patterns tab: the matrix profile of a field (where does the series repeat itself, and
 * where is it unique?) and its contextual matrix profile (which days, or weeks, look alike?),
 * as a heatmap you can click.
 */
import { ZoomGroup, renderChart, type Point } from './chart.js';
import { computeProfiles, contextDeviation, contextsOf, fillGaps, toGrid, type Contexts, type GapFill, type Grid, type Profiles } from './matrixprofile.js';
import type { ProfileJob } from './matrixprofile.worker.js';

export interface PatternField {
  id: string;
  label: string;
  unit?: string;
}

export interface PatternInput {
  /** The numeric fields. */
  fields: PatternField[];
  times: string[];
  /** The values of a field, aligned with `times`. */
  values(fieldId: string): (string | undefined)[];
  symbol(unit?: string): string;
}

/** Longer series take too long to compare window by window (a minute for 100 000 values). */
const MAX_VALUES = 50_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const STOPS = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

/** A colour for 0 (similar) to 1 (different): the viridis scale. */
function colour(t: number): [number, number, number] {
  const scaled = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  return [0, 1, 2].map((c) => Math.round(STOPS[i][c] + (STOPS[i + 1][c] - STOPS[i][c]) * f)) as [number, number, number];
}

const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const date = (t: number) => new Date(t).toISOString().slice(0, 10);
const weekday = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const duration = (ms: number) => (ms % DAY === 0 ? `${ms / DAY} d` : ms % HOUR === 0 ? `${ms / HOUR} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms / 1000} s`);

function element<K extends keyof HTMLElementTagNameMap>(name: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Starts the worker, or `null` where there is none: then the profiles are computed in the page. */
function startWorker(): Worker | null {
  try {
    return new Worker(new URL('./matrixprofile.worker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

export function renderPatterns(panel: HTMLElement, input: PatternInput): () => void {
  panel.replaceChildren();
  const stops: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker = startWorker();
  let runs = 0;
  const waiting = new Map<number, { resolve(result: Profiles): void; reject(error: Error): void; progress(fraction: number): void }>();

  const attach = (w: Worker) => {
    w.onmessage = (event: MessageEvent<{ id: number; progress?: number; result?: Profiles; error?: string }>) => {
      const job = waiting.get(event.data.id);
      if (!job) return;
      if (event.data.progress !== undefined) job.progress(event.data.progress);
      else if (event.data.error) {
        waiting.delete(event.data.id);
        job.reject(new Error(event.data.error));
      } else {
        waiting.delete(event.data.id);
        job.resolve(event.data.result!);
      }
    };
    w.onerror = () => {
      // no module workers here: continue in the page
      worker = null;
      for (const job of waiting.values()) job.reject(new Error('worker'));
      waiting.clear();
    };
  };
  if (worker) attach(worker);

  async function compute(id: number, values: Float64Array, m: number, contexts: Contexts, progress: (fraction: number) => void): Promise<Profiles> {
    if (worker) {
      try {
        return await new Promise<Profiles>((resolve, reject) => {
          waiting.set(id, { resolve, reject, progress });
          const job: ProfileJob = { id, values: values.slice(), m, of: contexts.of.slice(), count: contexts.count };
          worker!.postMessage(job, [job.values.buffer, job.of.buffer]);
        });
      } catch (error) {
        if ((error as Error).message !== 'worker') throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return computeProfiles(values, m, contexts, { onProgress: progress });
  }

  /* ---------- controls ---------- */

  panel.append(
    element(
      'p',
      'muted',
      'The matrix profile gives every window of the series the distance to the most similar other window: low where a pattern repeats, high where the series does something unique. The contextual matrix profile (De Paepe et al., 2020) compares whole days or weeks: the cell of two days holds the distance of their best matching windows, so the days that look alike form blocks.',
    ),
  );
  const toolbar = element('div', 'toolbar');
  const fieldSelect = element('select');
  for (const f of input.fields) fieldSelect.append(new Option(`${f.label}${f.unit ? ` (${input.symbol(f.unit)})` : ''}`, f.id));
  const periodSelect = element('select');
  periodSelect.append(new Option('day', 'day'), new Option('week', 'week'));
  const windowInput = element('input');
  windowInput.type = 'number';
  windowInput.min = '2';
  windowInput.style.width = '5rem';
  const shiftInput = element('input');
  shiftInput.type = 'number';
  shiftInput.min = '0';
  shiftInput.style.width = '4rem';
  const labelled = (text: string, control: HTMLElement) => {
    const label = element('label', undefined, `${text} `);
    label.append(control);
    return label;
  };
  const gapSelect = element('select');
  gapSelect.append(new Option('draw a line across', 'linear'), new Option('count as zero', 'zero'), new Option('skip the windows', 'none'));
  gapSelect.title = 'A window cannot contain a step without a value';
  const windowText = element('span', 'muted');
  toolbar.append(labelled('Field', fieldSelect), labelled('Context per', periodSelect), labelled('Window (values)', windowInput), labelled('Shift tolerance (values)', shiftInput), labelled('Missing values', gapSelect), windowText);
  const status = element('p', 'status');
  const results = element('div');
  panel.append(toolbar, status, results);

  let grid: Grid | null = null;
  let samplesPerPeriod = 1;

  /** The defaults for the field and period: a window that fills the period but for the shift. */
  function reset(): void {
    const field = fieldSelect.value;
    const times = input.times.map((t) => Date.parse(t));
    const numbers = input.values(field).map((v) => (v === undefined ? null : Number(v)));
    grid = toGrid(times, numbers);
    if (!grid) return;
    const period = periodSelect.value === 'week' ? 7 * DAY : DAY;
    samplesPerPeriod = Math.round(period / grid.step);
    const shift = Math.min(2, Math.max(0, samplesPerPeriod - 3));
    shiftInput.value = String(shift);
    windowInput.value = String(Math.max(2, samplesPerPeriod - shift));
  }

  /* ---------- results ---------- */

  async function run(): Promise<void> {
    const id = ++runs;
    results.replaceChildren();
    for (const stop of stops.splice(0)) stop();
    if (!grid) {
      status.textContent = 'This field has no regular time step, which the matrix profile needs.';
      return;
    }
    if (grid.values.length > MAX_VALUES) {
      status.textContent = `${grid.values.length} values are too many for comparing windows in the page (at most ${MAX_VALUES}).`;
      return;
    }
    const m = Math.min(Math.max(2, Math.round(Number(windowInput.value) || 2)), grid.values.length - 1);
    const shift = Math.max(0, Math.round(Number(shiftInput.value) || 0));
    const period = periodSelect.value === 'week' ? 'week' : 'day';
    windowText.textContent = `a window is ${duration(m * grid.step)}, one value per ${duration(grid.step)}`;
    const contexts = contextsOf(grid, m, { period, shift });
    const filled = fillGaps(grid.values, gapSelect.value as GapFill);
    const started = performance.now();
    status.textContent = 'Comparing the windows … 0%';
    let profiles: Profiles;
    try {
      profiles = await compute(id, filled, m, contexts, (fraction) => {
        if (id === runs) status.textContent = `Comparing the windows … ${Math.round(fraction * 100)}%`;
      });
    } catch (error) {
      if (id === runs) status.textContent = (error as Error).message;
      return;
    }
    if (id !== runs) return;
    const gaps = grid.values.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
    const finite = profiles.profile.reduce((n, v) => n + (Number.isNaN(v) ? 0 : 1), 0);
    status.textContent = `${profiles.windows} windows of ${m} values compared in ${Math.round(performance.now() - started)} ms (${finite} with a match${gaps ? `; ${gaps} of ${grid.values.length} values were missing, and are ${gapSelect.value === 'zero' ? 'counted as zero' : gapSelect.value === 'linear' ? 'filled by a line between their neighbours' : 'left out with the windows around them'}` : ''}).`;
    show(grid, filled, m, contexts, profiles);
  }

  function show(g: Grid, filled: Float64Array, m: number, contexts: Contexts, profiles: Profiles): void {
    const zoom = new ZoomGroup();
    const timeAt = (i: number) => g.t0 + i * g.step;

    /* the series and its matrix profile, on one time axis */
    const seriesPoints: Point[] = Array.from(g.values, (v, i) => ({ t: timeAt(i), v: Number.isNaN(v) ? null : v }));
    const profilePoints: Point[] = Array.from(profiles.profile, (v, i) => ({ t: timeAt(i) + ((m - 1) / 2) * g.step, v: Number.isNaN(v) ? null : v }));
    const field = input.fields.find((f) => f.id === fieldSelect.value)!;

    const first = element('div', 'chart');
    first.append(element('h3', undefined, `${field.label}${field.unit ? ` (${input.symbol(field.unit)})` : ''}`));
    const firstArea = element('div');
    first.append(firstArea);
    const second = element('div', 'chart');
    second.append(element('h3', undefined, 'Matrix profile'));
    second.append(element('p', 'note', 'Low: the window repeats elsewhere in the series (a motif). High: the window is unique (a discord). Zooming one chart zooms the other.'));
    const secondArea = element('div');
    second.append(secondArea);
    results.append(first, second);
    stops.push(renderChart(firstArea, { series: [{ name: field.label, points: seriesPoints }], unit: field.unit ? input.symbol(field.unit) : undefined, zoom }));
    stops.push(renderChart(secondArea, { series: [{ name: `Distance to the nearest window of ${m} values`, points: profilePoints }], zoom }));

    let motif = -1;
    let discord = -1;
    profiles.profile.forEach((v, i) => {
      if (Number.isNaN(v)) return;
      if (motif < 0 || v < profiles.profile[motif]) motif = i;
      if (discord < 0 || v > profiles.profile[discord]) discord = i;
    });
    if (motif >= 0) {
      const summary = element('p', 'note');
      summary.textContent = `Best motif: the windows starting ${stamp(timeAt(motif))} and ${stamp(timeAt(profiles.index[motif]))} (distance ${profiles.profile[motif].toFixed(2)}). Most unique window: starting ${stamp(timeAt(discord))} (distance ${profiles.profile[discord].toFixed(2)}).`;
      second.append(summary);
    }

    /* the contextual matrix profile */
    const section = element('div', 'chart');
    const unit = contexts.period === 7 * DAY ? 'week' : 'day';
    section.append(element('h3', undefined, `Contextual matrix profile: ${unit} against ${unit}`));
    results.append(section);
    if (contexts.count < 2) {
      section.append(element('p', 'note', `The series needs at least two ${unit}s with a window that starts within the shift tolerance.`));
      return;
    }
    const { count } = contexts;
    const finiteCells = Array.from(profiles.cmp).filter((v) => v !== Infinity).sort((a, b) => a - b);
    if (finiteCells.length === 0) {
      section.append(element('p', 'note', 'No two contexts have windows without a missing value to compare.'));
      return;
    }
    const top = finiteCells[Math.min(finiteCells.length - 1, Math.floor(finiteCells.length * 0.95))] || 1;
    section.append(
      element(
        'p',
        'note',
        `Every row and column is a ${unit}, from ${date(contexts.starts[0])} to ${date(contexts.starts[count - 1])}. A cell is the distance between the best matching windows of two ${unit}s (they may start up to ${shiftInput.value} value(s) apart): dark is similar, yellow is different. Grey: no comparison. Click a cell to see the two windows.`,
      ),
    );

    const layout = element('div', 'cmp-layout');
    const figure = element('div', 'cmp-figure');
    const canvas = element('canvas', 'cmp');
    canvas.width = count;
    canvas.height = count;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(count, count);
    for (let a = 0; a < count; a++) {
      for (let b = 0; b < count; b++) {
        const d = profiles.cmp[a * count + b];
        const o = 4 * (a * count + b);
        const [r, gr, bl] = d === Infinity ? [226, 232, 238] : colour(d / top);
        image.data[o] = r;
        image.data[o + 1] = gr;
        image.data[o + 2] = bl;
        image.data[o + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const tip = element('div', 'tooltip');
    tip.hidden = true;
    const axis = element('div', 'cmp-axis');
    for (const c of [0, Math.floor((count - 1) / 2), count - 1]) axis.append(element('span', undefined, date(contexts.starts[c])));
    const legend = element('div', 'cmp-legend');
    const bar = element('span', 'cmp-bar');
    bar.style.background = `linear-gradient(to right, ${STOPS.map((s) => `rgb(${s.join(',')})`).join(',')})`;
    legend.append(element('span', undefined, 'similar'), bar, element('span', undefined, `different (${top.toFixed(1)}+)`));
    figure.append(canvas, tip, axis, legend);

    const side = element('div', 'cmp-side');
    const deviation = contextDeviation(profiles.cmp, count);
    const ranked = Array.from(deviation, (v, c) => ({ c, v })).filter((x) => !Number.isNaN(x.v)).sort((a, b) => b.v - a.v).slice(0, 6);
    side.append(element('h4', undefined, `The ${unit}s that differ most from the others`));
    side.append(element('p', 'note', 'The mean distance to all other contexts: a day or week that stands out as an anomaly even where it is not a discord.'));
    const list = element('ol', 'cmp-list');
    for (const { c, v } of ranked) {
      const t = contexts.starts[c];
      list.append(element('li', undefined, `${unit === 'day' ? `${date(t)} (${weekday(t)})` : `week of ${date(t)}`}: ${v.toFixed(2)}`));
    }
    side.append(list);
    layout.append(figure, side);
    section.append(layout);

    const matchBox = element('div', 'cmp-match');
    section.append(matchBox);

    const cellAt = (event: MouseEvent) => {
      const box = canvas.getBoundingClientRect();
      const b = Math.min(count - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * count)));
      const a = Math.min(count - 1, Math.max(0, Math.floor(((event.clientY - box.top) / box.height) * count)));
      return { a, b };
    };
    const label = (c: number) => (unit === 'day' ? `${date(contexts.starts[c])} (${weekday(contexts.starts[c])})` : `week of ${date(contexts.starts[c])}`);
    canvas.addEventListener('mousemove', (event) => {
      const { a, b } = cellAt(event);
      const d = profiles.cmp[a * count + b];
      tip.hidden = false;
      tip.textContent = `${label(a)} and ${label(b)}: ${d === Infinity ? 'no comparison' : d.toFixed(2)}`;
      const figureBox = figure.getBoundingClientRect();
      tip.style.left = `${Math.min(event.clientX - figureBox.left + 12, figureBox.width - 240)}px`;
      tip.style.top = `${event.clientY - figureBox.top + 14}px`;
    });
    canvas.addEventListener('mouseleave', () => (tip.hidden = true));
    canvas.addEventListener('click', (event) => {
      const { a, b } = cellAt(event);
      const d = profiles.cmp[a * count + b];
      matchBox.replaceChildren();
      if (d === Infinity) {
        matchBox.append(element('p', 'note', `${label(a)} and ${label(b)} are not compared.`));
        return;
      }
      const i = profiles.cmpWindows[2 * (a * count + b)];
      const j = profiles.cmpWindows[2 * (a * count + b) + 1];
      matchBox.append(
        element(
          'p',
          'note',
          `${label(a)} and ${label(b)}: the best match is the window of ${duration(m * g.step)} starting ${stamp(timeAt(i))} against the one starting ${stamp(timeAt(j))}, at distance ${d.toFixed(2)}. The distance compares shapes, so the levels may differ: the second window is shown at the time of the first. Missing values are shown as they were compared (${gapSelect.value === 'linear' ? 'a line across' : gapSelect.value === 'zero' ? 'zero' : 'not filled'}).`,
        ),
      );
      const area = element('div');
      matchBox.append(area);
      const window = (start: number, shiftTo: number): Point[] =>
        Array.from({ length: m }, (_, k) => ({ t: timeAt(shiftTo + k), v: Number.isNaN(filled[start + k]) ? null : filled[start + k] }));
      stops.push(
        renderChart(area, {
          series: [
            { name: stamp(timeAt(i)), points: window(i, i) },
            { name: `${stamp(timeAt(j))} (shown at ${stamp(timeAt(i))})`, points: window(j, i) },
          ],
          unit: field.unit ? input.symbol(field.unit) : undefined,
        }),
      );
    });
  }

  /* ---------- wiring ---------- */

  const schedule = () => {
    clearTimeout(timer);
    status.textContent = 'Comparing the windows …';
    timer = setTimeout(() => void run(), 250);
  };
  fieldSelect.addEventListener('change', () => {
    reset();
    schedule();
  });
  periodSelect.addEventListener('change', () => {
    reset();
    schedule();
  });
  gapSelect.addEventListener('change', schedule);
  windowInput.addEventListener('input', schedule);
  shiftInput.addEventListener('input', schedule);

  if (input.fields.length === 0) status.textContent = 'This snippet has no numeric fields.';
  else {
    reset();
    void run();
  }

  return () => {
    clearTimeout(timer);
    runs++;
    worker?.terminate();
    for (const stop of stops.splice(0)) stop();
  };
}
