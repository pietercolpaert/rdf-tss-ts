import { describe, expect, it } from 'vitest';
import { aggregate, bucketName, bucketSize, pointBudget, visiblePoints, type Point } from '../playground/downsample.js';

const hour = 3_600_000;
const day = 24 * hour;
const start = Date.UTC(2026, 0, 1);
const hourly = (count: number, value: (i: number) => number | null = (i) => i): Point[] => Array.from({ length: count }, (_, i) => ({ t: start + i * hour, v: value(i) }));

describe('downsampling for display', () => {
  it('picks the smallest round bucket that fits the budget', () => {
    expect(bucketSize(116 * day, 171)).toBe(day);
    expect(bucketSize(7 * day, 171)).toBe(hour);
    expect(bucketSize(365 * day, 100)).toBe(7 * day);
    expect(bucketSize(1e4 * 365 * day, 10)).toBe(365 * day);
    expect(bucketName(day)).toBe('day');
    expect(bucketName(7 * day)).toBe('week');
  });

  it('keeps the average, the extremes and the count of every bucket', () => {
    const buckets = aggregate(hourly(48, (i) => (i % 24 === 5 ? 100 : i % 24)), day);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ start, t: start + day / 2, min: 0, max: 100, count: 24 });
    expect(buckets[0].v).toBeCloseTo((0 + 1 + 2 + 3 + 4 + 100 + [...Array(18).keys()].reduce((a, i) => a + i + 6, 0)) / 24, 9);
  });

  it('skips missing values and leaves empty buckets out', () => {
    const points: Point[] = [...hourly(24, () => null), ...hourly(24).map((p) => ({ ...p, t: p.t + 3 * day }))];
    const buckets = aggregate(points, day);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].start).toBe(start + 3 * day);
    expect(buckets[0].count).toBe(24);
  });

  it('aligns buckets on UTC', () => {
    const [bucket] = aggregate([{ t: Date.UTC(2026, 2, 20, 13), v: 1 }], day);
    expect(new Date(bucket.start).toISOString()).toBe('2026-03-20T00:00:00.000Z');
  });

  it('takes the points of the visible range, with one more on each side', () => {
    const points = hourly(100);
    const slice = visiblePoints(points, start + 10 * hour, start + 20 * hour);
    expect(slice[0].t).toBe(start + 9 * hour);
    expect(slice[slice.length - 1].t).toBe(start + 21 * hour);
    expect(slice).toHaveLength(13);
    expect(visiblePoints(points, start - 5 * day, start + 200 * day)).toHaveLength(100);
    expect(visiblePoints([], 0, 1)).toEqual([]);
  });

  it('gives a point per few pixels, and never less than a hundred', () => {
    expect(pointBudget(1000)).toBe(166);
    expect(pointBudget(100)).toBe(100);
  });
});
