/** A small dependency-free line chart in SVG, with a legend that toggles series and a tooltip. */

export interface Point {
  /** Milliseconds since the epoch. */
  t: number;
  /** `null` is a missing value: the line breaks. */
  v: number | null;
}

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

export function renderChart(container: HTMLElement, options: ChartOptions): () => void {
  container.replaceChildren();
  const visible = new Set(options.series.map((s) => s.name));
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  const legend = document.createElement('div');
  legend.className = 'legend';
  container.append(wrap, legend);

  const color = (name: string) => COLORS[options.series.findIndex((s) => s.name === name) % COLORS.length];

  options.series.forEach((series) => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      if (box.checked) visible.add(series.name);
      else visible.delete(series.name);
      draw();
    });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = color(series.name);
    label.append(box, swatch, document.createTextNode(series.name));
    legend.append(label);
  });

  function draw(): void {
    wrap.replaceChildren();
    const width = Math.max(320, container.clientWidth || 900);
    const height = 260;
    const shown = options.series.filter((s) => visible.has(s.name));
    const all = shown.flatMap((s) => s.points.filter((p) => p.v !== null) as { t: number; v: number }[]);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
    wrap.append(svg);
    if (all.length === 0) {
      const text = el('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' });
      text.textContent = 'No values to show';
      svg.append(text);
      return;
    }

    let tMin = Math.min(...options.series.flatMap((s) => s.points.map((p) => p.t)));
    let tMax = Math.max(...options.series.flatMap((s) => s.points.map((p) => p.t)));
    if (tMin === tMax) {
      tMin -= 3_600_000;
      tMax += 3_600_000;
    }
    let vMin = Math.min(...all.map((p) => p.v));
    let vMax = Math.max(...all.map((p) => p.v));
    if (options.zero) vMin = Math.min(0, vMin);
    const pad = (vMax - vMin || Math.abs(vMax) || 1) * 0.06;
    vMax += pad;
    if (!options.zero || vMin < 0) vMin -= pad;
    const yTicks = niceTicks(vMin, vMax);
    vMin = Math.min(vMin, yTicks[0]);
    vMax = Math.max(vMax, yTicks[yTicks.length - 1]);

    const x = (t: number) => M.l + ((t - tMin) / (tMax - tMin)) * (width - M.l - M.r);
    const y = (v: number) => height - M.b - ((v - vMin) / (vMax - vMin)) * (height - M.t - M.b);

    const axis = el('g', { class: 'axis' });
    for (const tick of yTicks) {
      axis.append(el('line', { class: 'grid', x1: M.l, x2: width - M.r, y1: y(tick), y2: y(tick) }));
      const text = el('text', { x: M.l - 8, y: y(tick) + 4, 'text-anchor': 'end' });
      text.textContent = formatTick(tick);
      axis.append(text);
    }
    const format = timeFormatter(tMax - tMin);
    const xTickCount = Math.max(2, Math.min(8, Math.floor((width - M.l - M.r) / 90)));
    for (const t of timeTicks(tMin, tMax, xTickCount)) {
      const text = el('text', { x: x(t), y: height - 10, 'text-anchor': 'middle' });
      text.textContent = format(t);
      axis.append(text);
    }
    const utc = el('text', { x: width - M.r, y: M.t + 2, 'text-anchor': 'end' });
    utc.textContent = `${options.unit ? options.unit + ' · ' : ''}UTC`;
    axis.append(utc);
    svg.append(axis);

    for (const series of shown) {
      let d = '';
      let previous: Point | null = null;
      for (const p of series.points) {
        if (p.v === null) {
          previous = null;
          continue;
        }
        if (previous === null) d += `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
        else if (options.step) d += `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}`;
        else d += `L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
        previous = p;
      }
      svg.append(el('path', { class: 'line', d, stroke: color(series.name) }));
      const present = series.points.filter((p) => p.v !== null);
      if (present.length <= 60) {
        for (const p of present) svg.append(el('circle', { class: 'dot', cx: x(p.t), cy: y(p.v!), r: 3, fill: color(series.name) }));
      }
    }

    // tooltip: the nearest time with a value in any shown series
    const times = [...new Set(shown.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
    const cursor = el('line', { class: 'cursor', y1: M.t, y2: height - M.b, visibility: 'hidden' });
    const tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    const overlay = el('rect', { x: M.l, y: M.t, width: width - M.l - M.r, height: height - M.t - M.b, fill: 'transparent' });
    svg.append(cursor, overlay);
    wrap.append(tip);
    overlay.addEventListener('mousemove', (event) => {
      const box = svg.getBoundingClientRect();
      const px = ((event.clientX - box.left) / box.width) * width;
      const t = tMin + ((px - M.l) / (width - M.l - M.r)) * (tMax - tMin);
      let nearest = times[0];
      for (const candidate of times) if (Math.abs(candidate - t) < Math.abs(nearest - t)) nearest = candidate;
      cursor.setAttribute('x1', String(x(nearest)));
      cursor.setAttribute('x2', String(x(nearest)));
      cursor.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.replaceChildren(document.createTextNode(fullTime(nearest)));
      for (const s of shown) {
        const point = s.points.find((p) => p.t === nearest);
        const line = document.createElement('div');
        line.textContent = `${s.name}: ${point?.v ?? '–'}${point?.v != null && options.unit ? ' ' + options.unit : ''}`;
        line.style.borderLeft = `4px solid ${color(s.name)}`;
        line.style.paddingLeft = '6px';
        tip.append(line);
      }
      const left = (x(nearest) / width) * box.width;
      tip.style.left = `${Math.min(left + 12, box.width - 170)}px`;
      tip.style.top = `${M.t + 8}px`;
    });
    overlay.addEventListener('mouseleave', () => {
      cursor.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
  }

  draw();
  const observer = new ResizeObserver(() => draw());
  observer.observe(container);
  return () => observer.disconnect();
}
