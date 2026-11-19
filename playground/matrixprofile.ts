/**
 * The matrix profile and the contextual matrix profile (CMP) of a series, without dependencies.
 *
 * The matrix profile of a series with subsequences ("windows") of `m` values holds, for every
 * window, the z-normalised Euclidean distance to its nearest other window. A low value is a
 * motif (a pattern that repeats), a high value a discord (something unique). The CMP
 * (De Paepe et al., "A generalized matrix profile framework with support for contextual series
 * analysis", Engineering Applications of AI 90, 2020) takes the minimum over rectangular regions
 * of the distance matrix instead of over its columns: with one context per day, cell (a, b) is
 * the best match between any window of day a and any window of day b, which shows which days
 * resemble each other.
 *
 * The distances are computed along the diagonals of the distance matrix (as in STOMP/SCAMP): the
 * dot product of two windows follows from the one before it in O(1), so all n² / 2 pairs cost
 * O(n²) in total, with no FFT.
 */

export interface Grid {
  /** Time of the first value, in milliseconds since the epoch. */
  t0: number;
  /** Milliseconds between values. */
  step: number;
  /** One value per step; `NaN` where the series has none. */
  values: Float64Array;
}

/** The most common positive distance between consecutive times: the sampling step of the series. */
export function sampleStep(times: number[]): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < times.length; i++) {
    const diff = times[i] - times[i - 1];
    if (diff > 0) counts.set(diff, (counts.get(diff) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [diff, count] of counts) {
    if (count > bestCount || (count === bestCount && diff < best)) {
      best = diff;
      bestCount = count;
    }
  }
  return best;
}

/** The series on a regular grid, with `NaN` for the steps without a value. `null` when it has no step or is too long. */
export function toGrid(times: number[], values: (number | null | undefined)[], limit = 2_000_000): Grid | null {
  if (times.length < 2) return null;
  const step = sampleStep(times);
  if (step <= 0) return null;
  const t0 = times[0];
  const length = Math.round((times[times.length - 1] - t0) / step) + 1;
  if (length > limit) return null;
  const grid = new Float64Array(length).fill(NaN);
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const slot = Math.round((times[i] - t0) / step);
    if (slot >= 0 && slot < length) grid[slot] = v;
  }
  return { t0, step, values: grid };
}

const DAY = 86_400_000;
/** 1970-01-05 was a Monday: weeks are counted from there. */
const MONDAY = 4 * DAY;

/**
 * What to do with the steps that have no value, which a window cannot contain: leave them
 * (windows with a gap are skipped), count them as zero, or draw a line between the values around
 * the gap. A gap at the start or the end of the series stays empty.
 */
export type GapFill = 'none' | 'zero' | 'linear';

export function fillGaps(values: Float64Array, mode: GapFill): Float64Array {
  if (mode === 'none') return values;
  const out = Float64Array.from(values);
  if (mode === 'zero') {
    for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) out[i] = 0;
    return out;
  }
  let previous = -1;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(out[i])) continue;
    if (previous >= 0 && i - previous > 1) {
      for (let k = previous + 1; k < i; k++) out[k] = out[previous] + ((out[i] - out[previous]) * (k - previous)) / (i - previous);
    }
    previous = i;
  }
  return out;
}

export interface ContextOptions {
  /** `'day'` or `'week'` (UTC), or a number of milliseconds. */
  period: 'day' | 'week' | number;
  /**
   * A window belongs to the context of the period it starts in when it starts at most this many
   * steps after the start of that period: the tolerance for shifts between periods.
   */
  shift: number;
}

export interface Contexts {
  /** For every window, the index of its context, or -1 when it is in none. */
  of: Int32Array;
  /** The number of contexts. */
  count: number;
  /** The start time of every context. */
  starts: number[];
  period: number;
}

/** One context per period, from the first to the last, for the windows that start near the start of a period. */
export function contextsOf(grid: Grid, m: number, options: ContextOptions): Contexts {
  const period = options.period === 'day' ? DAY : options.period === 'week' ? 7 * DAY : options.period;
  const anchor = options.period === 'week' ? MONDAY : 0;
  const windows = Math.max(0, grid.values.length - m + 1);
  const periods = new Float64Array(windows).fill(NaN);
  let first = Infinity;
  let last = -Infinity;
  for (let i = 0; i < windows; i++) {
    const t = grid.t0 + i * grid.step;
    const index = Math.floor((t - anchor) / period);
    const offset = t - anchor - index * period;
    if (offset > options.shift * grid.step + 1e-6) continue;
    periods[i] = index;
    if (index < first) first = index;
    if (index > last) last = index;
  }
  const of = new Int32Array(windows).fill(-1);
  if (first === Infinity) return { of, count: 0, starts: [], period };
  const count = last - first + 1;
  for (let i = 0; i < windows; i++) if (!Number.isNaN(periods[i])) of[i] = periods[i] - first;
  return { of, count, starts: Array.from({ length: count }, (_, c) => anchor + (first + c) * period), period };
}

export interface Profiles {
  windows: number;
  m: number;
  /** Distance to the nearest other window; `NaN` for a window with a missing value or without a match. */
  profile: Float64Array;
  /** The start of the nearest window, or -1. */
  index: Int32Array;
  /** `count × count`: the best distance between the windows of two contexts; `Infinity` where there is none. */
  cmp: Float64Array;
  /** For every cell of the CMP the two windows (a start in the row's context, a start in the column's context), or -1. */
  cmpWindows: Int32Array;
  count: number;
}

/** Windows whose values are all present, with their mean and standard deviation (0 for a flat window). */
function windowStats(x: Float64Array, m: number): { valid: Uint8Array; mean: Float64Array; sigma: Float64Array } {
  const windows = x.length - m + 1;
  const valid = new Uint8Array(windows);
  const mean = new Float64Array(windows);
  const sigma = new Float64Array(windows);
  let missing = 0;
  for (let k = 0; k < m - 1; k++) if (Number.isNaN(x[k])) missing++;
  for (let i = 0; i < windows; i++) {
    if (Number.isNaN(x[i + m - 1])) missing++;
    if (i > 0 && Number.isNaN(x[i - 1])) missing--;
    if (missing > 0) continue;
    let sum = 0;
    for (let k = 0; k < m; k++) sum += x[i + k];
    const average = sum / m;
    let squares = 0;
    for (let k = 0; k < m; k++) squares += (x[i + k] - average) ** 2;
    const deviation = Math.sqrt(squares / m);
    valid[i] = 1;
    mean[i] = average;
    // a window whose values only differ by rounding is flat
    sigma[i] = deviation <= 1e-9 * Math.max(1, Math.abs(average)) ? 0 : deviation;
  }
  return { valid, mean, sigma };
}

/**
 * The matrix profile and the CMP of the series `x` for windows of `m` values. Windows that start
 * less than `exclusion` values apart do not count as matches of each other (default `m / 4`), and
 * two windows of the same context are not compared in the CMP.
 */
export function computeProfiles(
  series: Float64Array,
  m: number,
  contexts: { of: Int32Array; count: number },
  options: { exclusion?: number; onProgress?: (fraction: number) => void } = {},
): Profiles {
  if (!Number.isInteger(m) || m < 2) throw new RangeError('the window must have at least 2 values');
  const windows = series.length - m + 1;
  const count = contexts.count;
  const profile = new Float64Array(Math.max(0, windows)).fill(Infinity);
  const index = new Int32Array(Math.max(0, windows)).fill(-1);
  const cmp = new Float64Array(count * count).fill(Infinity);
  const cmpWindows = new Int32Array(count * count * 2).fill(-1);
  if (windows < 1) return { windows: 0, m, profile, index, cmp, cmpWindows, count };

  const exclusion = options.exclusion ?? Math.ceil(m / 4);
  const { valid, mean, sigma } = windowStats(series, m);
  // missing values count as 0 in the running dot products; windows that contain one are skipped
  const x = series.map((v) => (Number.isNaN(v) ? 0 : v));
  const dot = (i: number, j: number) => {
    let sum = 0;
    for (let k = 0; k < m; k++) sum += x[i + k] * x[j + k];
    return sum;
  };

  const every = Math.max(1, Math.floor((windows - exclusion - 1) / 50));
  for (let k = exclusion + 1; k < windows; k++) {
    let qt = 0;
    for (let i = 0; i + k < windows; i++) {
      const j = i + k;
      qt = i % 256 === 0 ? dot(i, j) : qt + x[i + m - 1] * x[j + m - 1] - x[i - 1] * x[j - 1];
      if (!valid[i] || !valid[j]) continue;
      const si = sigma[i];
      const sj = sigma[j];
      let squared: number;
      if (si === 0 && sj === 0) squared = 0;
      else if (si === 0 || sj === 0) squared = m;
      else squared = Math.max(0, 2 * m * (1 - (qt - m * mean[i] * mean[j]) / (m * si * sj)));
      const d = Math.sqrt(squared);
      if (d < profile[i]) {
        profile[i] = d;
        index[i] = j;
      }
      if (d < profile[j]) {
        profile[j] = d;
        index[j] = i;
      }
      const a = contexts.of[i];
      const b = contexts.of[j];
      if (a >= 0 && b >= 0 && a !== b) {
        const ab = a * count + b;
        if (d < cmp[ab]) {
          cmp[ab] = d;
          cmpWindows[2 * ab] = i;
          cmpWindows[2 * ab + 1] = j;
        }
        const ba = b * count + a;
        if (d < cmp[ba]) {
          cmp[ba] = d;
          cmpWindows[2 * ba] = j;
          cmpWindows[2 * ba + 1] = i;
        }
      }
    }
    if (options.onProgress && (k - exclusion) % every === 0) options.onProgress(1 - ((windows - k) / windows) ** 2);
  }
  for (let i = 0; i < windows; i++) if (!valid[i] || profile[i] === Infinity) profile[i] = NaN;
  return { windows, m, profile, index, cmp, cmpWindows, count };
}

/** How different each context is from the others: the mean of its row of the CMP, not counting itself or the cells without a match. */
export function contextDeviation(cmp: Float64Array, count: number): Float64Array {
  const out = new Float64Array(count).fill(NaN);
  for (let a = 0; a < count; a++) {
    let sum = 0;
    let n = 0;
    for (let b = 0; b < count; b++) {
      const d = cmp[a * count + b];
      if (a === b || d === Infinity) continue;
      sum += d;
      n++;
    }
    if (n > 0) out[a] = sum / n;
  }
  return out;
}
