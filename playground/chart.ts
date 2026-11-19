/**
 * A small dependency-free line chart in SVG, with a legend that toggles series and a tooltip.
 * A series with more points than the plot has room for is downsampled to the average per round
 * time bucket (a day, say) with a band from the minimum to the maximum; drag to zoom in, and the
 * buckets get smaller until the raw points show. Double-click to zoom out.
 */
import { aggregate, bucketName, bucketSize, pointBudget, visiblePoints, type Point } from './downsample.js';

export type { Point };

export interface Series {
  name: string;
  points: Point[];
}

export interface ChartOptions {
  series: Series[];
  /** Draw steps instead of slopes: right for counts per period. */
  step?: boolean;
  /** Start the y axis at zero. */
  zero?: boolean;
  unit?: string;
}

const COLORS = ['#3b6790', '#e08e0b', '#2f855a', '#c53030', '#805ad5', '#2c9ab7', '#b7791f', '#718096'];
const SVG = 'http://www.w3.org/2000/svg';
const M = { l: 56, r: 14, t: 10, b: 30 };

const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/** Round tick values: about `count` of them, at 1, 2 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad / 2;
    max += pad / 2;
  }
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** Times at round steps (every 3 hours, every day, …) in UTC. */
export function timeTicks(min: number, max: number, count: number): number[] {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const steps = [minute, 5 * minute, 10 * minute, 15 * minute, 30 * minute, hour, 2 * hour, 3 * hour, 6 * hour, 12 * hour, day, 2 * day, 7 * day, 14 * day, 30 * day, 90 * day, 365 * day];
  const raw = (max - min) / count;
  const step = steps.find((s) => s >= raw) ?? steps[steps.length - 1];
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
  return ticks;
}

const formatTick = (v: number) => (Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(1) : String(Number(v.toPrecision(6))));

function timeFormatter(range: number): (t: number) => string {
  const day = 86_400_000;
  const options: Intl.DateTimeFormatOptions =
    range <= 2 * day ? { hour: '2-digit', minute: '2-digit' } : range <= 120 * day ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short' };
  const format = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC', hour12: false });
  return (t) => format.format(t);
}

export const fullTime = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z').replace('T', ' ');

/** What is drawn for one time: a raw point, or a bucket of points with its average and extremes. */
interface Plotted {
  t: number;
  start: number;
  v: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

const round = (v: number) => String(Number(v.toPrecision(7)));
let charts = 0;

export function renderChart(container: HTMLElement, options: ChartOptions): () => void {
  container.replaceChildren();
  const id = `chart-${charts++}`;
  const series = options.series.map((s) => ({ ...s, points: s.points.every((p, i, all) => i === 0 || all[i - 1].t <= p.t) ? s.points : [...s.points].sort((a, b) => a.t - b.t) }));
  const visible = new Set(series.map((s) => s.name));
  let view: [number, number] | null = null;
  let downsample = true;

  const tools = document.createElement('div');
  tools.className = 'chart-tools';
  const status = document.createElement('span');
  status.className = 'chart-status';
  const toggle = document.createElement('label');
  const toggleBox = document.createElement('input');
  toggleBox.type = 'checkbox';
  toggleBox.checked = true;
  toggleBox.addEventListener('change', () => {
    downsample = toggleBox.checked;
    draw();
  });
  toggle.append(toggleBox, document.createTextNode(' Downsample large series'));
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset zoom';
  reset.hidden = true;
  reset.addEventListener('click', () => {
    view = null;
    draw();
  });
  tools.append(status, toggle, reset);
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  const legend = document.createElement('div');
  legend.className = 'legend';
  container.append(tools, wrap, legend);

  const color = (name: string) => COLORS[series.findIndex((s) => s.name === name) % COLORS.length];

  series.forEach((one) => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      if (box.checked) visible.add(one.name);
      else visible.delete(one.name);
      draw();
    });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = color(one.name);
    label.append(box, swatch, document.createTextNode(one.name));
    legend.append(label);
  });

  let fullMin = Infinity;
  let fullMax = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      if (p.t < fullMin) fullMin = p.t;
      if (p.t > fullMax) fullMax = p.t;
    }
  }
  if (fullMin === fullMax) {
    fullMin -= 3_600_000;
    fullMax += 3_600_000;
  }

  function draw(): void {
    wrap.replaceChildren();
    const width = Math.max(320, container.clientWidth || 900);
    const height = 260;
    const plotWidth = width - M.l - M.r;
    const shown = series.filter((s) => visible.has(s.name));
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
    wrap.append(svg);
    reset.hidden = view === null;

    const [tMin, tMax] = view ?? [fullMin, fullMax];
    const slices = shown.map((s) => visiblePoints(s.points, tMin, tMax));
    const most = Math.max(0, ...slices.map((slice) => slice.filter((p) => p.t >= tMin && p.t <= tMax && p.v !== null).length));
    const budget = pointBudget(plotWidth);
    const rawPlotted = (): Plotted[][] => slices.map((slice) => slice.map((p) => ({ t: p.t, start: p.t, v: p.v, min: p.v, max: p.v, count: p.v === null ? 0 : 1 })));
    let size = downsample && most > budget ? bucketSize(tMax - tMin, budget) : undefined;
    let plotted: Plotted[][] = rawPlotted();
    if (size) {
      const buckets = slices.map((slice) => aggregate(slice, size!));
      // sparse values: buckets of one value are no summary, so draw the values themselves
      if (Math.max(...buckets.map((b) => b.length)) > 0.6 * most) size = undefined;
      else plotted = buckets.map((list) => list.map((b) => ({ t: b.t, start: b.start, v: b.v, min: b.min, max: b.max, count: b.count })));
    }
    const zoomHint = 'Drag over the chart to zoom in, double-click to zoom out.';
    status.textContent = size
      ? `${most} values per series, shown as the average per ${bucketName(size)} with a band from the minimum to the maximum. ${zoomHint}`
      : view
        ? `${most} values per series, all shown. Double-click to zoom out.`
        : most > budget
          ? `${most} values per series, all shown. ${zoomHint}`
          : `${most} values per series. ${zoomHint}`;

    const inView = plotted.flat().filter((p) => p.v !== null && p.t >= tMin - (size ?? 0) && p.t <= tMax + (size ?? 0));
    if (inView.length === 0) {
      const text = el('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' });
      text.textContent = 'No values to show';
      svg.append(text);
      return;
    }

    let vMin = Math.min(...inView.map((p) => p.min!));
    let vMax = Math.max(...inView.map((p) => p.max!));
    if (options.zero) vMin = Math.min(0, vMin);
    const pad = (vMax - vMin || Math.abs(vMax) || 1) * 0.06;
    vMax += pad;
    if (!options.zero || vMin < 0) vMin -= pad;
    const yTicks = niceTicks(vMin, vMax);
    vMin = Math.min(vMin, yTicks[0]);
    vMax = Math.max(vMax, yTicks[yTicks.length - 1]);

    const x = (t: number) => M.l + ((t - tMin) / (tMax - tMin)) * plotWidth;
    const y = (v: number) => height - M.b - ((v - vMin) / (vMax - vMin)) * (height - M.t - M.b);
    const timeAt = (px: number) => tMin + ((px - M.l) / plotWidth) * (tMax - tMin);

    const axis = el('g', { class: 'axis' });
    for (const tick of yTicks) {
      axis.append(el('line', { class: 'grid', x1: M.l, x2: width - M.r, y1: y(tick), y2: y(tick) }));
      const text = el('text', { x: M.l - 8, y: y(tick) + 4, 'text-anchor': 'end' });
      text.textContent = formatTick(tick);
      axis.append(text);
    }
    const format = timeFormatter(tMax - tMin);
    const xTickCount = Math.max(2, Math.min(8, Math.floor(plotWidth / 90)));
    for (const t of timeTicks(tMin, tMax, xTickCount)) {
      const text = el('text', { x: x(t), y: height - 10, 'text-anchor': 'middle' });
      text.textContent = format(t);
      axis.append(text);
    }
    const utc = el('text', { x: width - M.r, y: M.t + 2, 'text-anchor': 'end' });
    utc.textContent = `${options.unit ? options.unit + ' · ' : ''}UTC`;
    axis.append(utc);
    svg.append(axis);

    const clip = el('clipPath', { id });
    clip.append(el('rect', { x: M.l, y: M.t, width: plotWidth, height: height - M.t - M.b }));
    svg.append(el('defs'), clip);
    const layer = el('g', { 'clip-path': `url(#${id})` });
    svg.append(layer);

    shown.forEach((one, index) => {
      // a line breaks at a missing value, and where a bucket is missing
      const segments: Plotted[][] = [];
      let current: Plotted[] = [];
      for (const p of plotted[index]) {
        const gap = current.length > 0 && size !== undefined && p.t - current[current.length - 1].t > 2.5 * size;
        if (p.v === null || gap) {
          if (current.length) segments.push(current);
          current = [];
          if (p.v === null) continue;
        }
        current.push(p);
      }
      if (current.length) segments.push(current);

      let d = '';
      let band = '';
      for (const segment of segments) {
        segment.forEach((p, i) => {
          const px = x(p.t).toFixed(1);
          const py = y(p.v!).toFixed(1);
          if (i === 0) d += `M${px},${py}`;
          else if (options.step && !size) d += `H${px}V${py}`;
          else d += `L${px},${py}`;
        });
        if (size && segment.length > 1) {
          band += `M${segment.map((p) => `${x(p.t).toFixed(1)},${y(p.max!).toFixed(1)}`).join('L')}`;
          band += `L${[...segment].reverse().map((p) => `${x(p.t).toFixed(1)},${y(p.min!).toFixed(1)}`).join('L')}Z`;
        }
      }
      if (band) layer.append(el('path', { class: 'band', d: band, fill: color(one.name) }));
      layer.append(el('path', { class: 'line', d, stroke: color(one.name) }));
      const present = plotted[index].filter((p) => p.v !== null);
      if (present.length <= 60) {
        for (const p of present) layer.append(el('circle', { class: 'dot', cx: x(p.t), cy: y(p.v!), r: 3, fill: color(one.name) }));
      }
    });

    // tooltip: the nearest time with a value in any shown series
    const byTime = plotted.map((points) => new Map(points.map((p) => [p.t, p])));
    const times = [...new Set(plotted.flatMap((points) => points.filter((p) => p.v !== null).map((p) => p.t)))].sort((a, b) => a - b);
    const cursor = el('line', { class: 'cursor', y1: M.t, y2: height - M.b, visibility: 'hidden' });
    const selection = el('rect', { class: 'selection', y: M.t, height: height - M.t - M.b, visibility: 'hidden' });
    const tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    const overlay = el('rect', { class: 'overlay', x: M.l, y: M.t, width: plotWidth, height: height - M.t - M.b, fill: 'transparent' });
    svg.append(cursor, selection, overlay);
    wrap.append(tip);

    const pixel = (event: PointerEvent | MouseEvent) => {
      const box = svg.getBoundingClientRect();
      return Math.min(width - M.r, Math.max(M.l, ((event.clientX - box.left) / box.width) * width));
    };
    let from: number | null = null;
    const hideTip = () => {
      cursor.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    };

    overlay.addEventListener('pointerdown', (event) => {
      from = pixel(event);
      overlay.setPointerCapture(event.pointerId);
    });
    overlay.addEventListener('pointermove', (event) => {
      const px = pixel(event);
      if (from !== null) {
        hideTip();
        selection.setAttribute('x', String(Math.min(from, px)));
        selection.setAttribute('width', String(Math.abs(px - from)));
        selection.setAttribute('visibility', 'visible');
        return;
      }
      if (times.length === 0) return;
      const t = timeAt(px);
      let nearest = times[0];
      for (const candidate of times) if (Math.abs(candidate - t) < Math.abs(nearest - t)) nearest = candidate;
      cursor.setAttribute('x1', String(x(nearest)));
      cursor.setAttribute('x2', String(x(nearest)));
      cursor.setAttribute('visibility', 'visible');
      tip.hidden = false;
      const first = byTime.map((m) => m.get(nearest)).find((p) => p);
      const heading = size ? `${size >= 86_400_000 ? new Date(first!.start).toISOString().slice(0, 10) : fullTime(first!.start)} · ${bucketName(size)}` : fullTime(nearest);
      tip.replaceChildren(document.createTextNode(heading));
      shown.forEach((one, index) => {
        const point = byTime[index].get(nearest);
        const line = document.createElement('div');
        const unit = point?.v != null && options.unit ? ` ${options.unit}` : '';
        line.textContent =
          point?.v == null
            ? `${one.name}: –`
            : size
              ? `${one.name}: ${round(point.v)}${unit} (${round(point.min!)} to ${round(point.max!)}, ${point.count} values)`
              : `${one.name}: ${round(point.v)}${unit}`;
        line.style.borderLeft = `4px solid ${color(one.name)}`;
        line.style.paddingLeft = '6px';
        tip.append(line);
      });
      const box = svg.getBoundingClientRect();
      const left = (x(nearest) / width) * box.width;
      tip.style.left = `${Math.min(left + 12, box.width - 260)}px`;
      tip.style.top = `${M.t + 8}px`;
    });
    overlay.addEventListener('pointerup', (event) => {
      if (from === null) return;
      const a = from;
      const b = pixel(event);
      from = null;
      selection.setAttribute('visibility', 'hidden');
      if (Math.abs(b - a) < 8) return;
      // zoom in on the selected times, but never on less than a minute
      let start = timeAt(Math.min(a, b));
      let end = timeAt(Math.max(a, b));
      if (end - start < 60_000) {
        const middle = (start + end) / 2;
        start = middle - 30_000;
        end = middle + 30_000;
      }
      view = [start, end];
      draw();
    });
    overlay.addEventListener('pointercancel', () => {
      from = null;
      selection.setAttribute('visibility', 'hidden');
    });
    overlay.addEventListener('dblclick', () => {
      view = null;
      draw();
    });
    overlay.addEventListener('mouseleave', hideTip);
  }

  draw();
  const observer = new ResizeObserver(() => draw());
  observer.observe(container);
  return () => observer.disconnect();
}
