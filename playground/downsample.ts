/**
 * Downsampling of a time series for display, in the spirit of FlexViz
 * (https://docs.flexviz.tech/guides/line-downsampling/): only the points of the visible time
 * range are considered, they are bucketed by equal time width, and a bucket keeps its mean and
 * its minimum and maximum, so a spike never disappears. Zooming in shows fewer rows per bucket,
 * and below the budget the raw points are drawn.
 */

export interface Point {
  /** Milliseconds since the epoch. */
  t: number;
  /** `null` is a missing value: the line breaks. */
  v: number | null;
  /** The interval around the value, such as one standard uncertainty: drawn as a band. */
  lo?: number | null;
  hi?: number | null;
}

/** All the points of a time bucket, as their mean, minimum and maximum. */
export interface Bucket {
  /** The middle of the bucket, where it is drawn. */
  t: number;
  /** The start of the bucket. */
  start: number;
  v: number;
  min: number;
  max: number;
  /** Number of values in the bucket. */
  count: number;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** Bucket widths that read well: 15 minutes, an hour, 6 hours, a day, a week, … */
export const BUCKET_SIZES = [minute, 5 * minute, 15 * minute, hour, 3 * hour, 6 * hour, 12 * hour, day, 2 * day, 7 * day, 14 * day, 30 * day, 90 * day, 365 * day];

/** The smallest round bucket width that gives at most `maxPoints` buckets over `span` milliseconds. */
export function bucketSize(span: number, maxPoints: number): number {
  return BUCKET_SIZES.find((size) => span / size <= maxPoints) ?? BUCKET_SIZES[BUCKET_SIZES.length - 1];
}

export function bucketName(size: number): string {
  const names = new Map([
    [minute, 'minute'], [5 * minute, '5 minutes'], [15 * minute, '15 minutes'], [hour, 'hour'], [3 * hour, '3 hours'], [6 * hour, '6 hours'], [12 * hour, '12 hours'],
    [day, 'day'], [2 * day, '2 days'], [7 * day, 'week'], [14 * day, '2 weeks'], [30 * day, '30 days'], [90 * day, '90 days'], [365 * day, 'year'],
  ]);
  return names.get(size) ?? `${size / 1000} s`;
}

/** The points in `[from, to]` and one on each side, so that the line runs to the edges. Points must be sorted by time. */
export function visiblePoints(points: Point[], from: number, to: number): Point[] {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid].t < from) low = mid + 1;
    else high = mid;
  }
  const start = Math.max(0, low - 1);
  high = points.length;
  let end = low;
  while (end < high && points[end].t <= to) end++;
  return points.slice(start, Math.min(points.length, end + 1));
}

/** Buckets of `size` milliseconds, aligned on UTC. Missing values are skipped; empty buckets are not returned. */
export function aggregate(points: Point[], size: number): Bucket[] {
  const out: Bucket[] = [];
  let key = NaN;
  let sum = 0;
  let count = 0;
  let min = 0;
  let max = 0;
  const flush = () => {
    if (count === 0) return;
    const start = key * size;
    out.push({ t: start + size / 2, start, v: sum / count, min, max, count });
  };
  for (const p of points) {
    if (p.v === null) continue;
    const k = Math.floor(p.t / size);
    if (k !== key) {
      flush();
      key = k;
      sum = 0;
      count = 0;
      min = Infinity;
      max = -Infinity;
    }
    sum += p.v;
    count++;
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  flush();
  return out;
}

/** The budget of points for a plot of this width in pixels: a point per six pixels or so. */
export const pointBudget = (plotWidth: number) => Math.max(100, Math.floor(plotWidth / 6));
