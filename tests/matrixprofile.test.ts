import { describe, expect, it } from 'vitest';
import { computeProfiles, contextDeviation, contextsOf, fillGaps, sampleStep, toGrid } from '../playground/matrixprofile.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The z-normalised Euclidean distance between two windows, the slow and obvious way. */
function distance(x: number[], i: number, j: number, m: number): number {
  const a = x.slice(i, i + m);
  const b = x.slice(j, j + m);
  const stats = (w: number[]) => {
    const mean = w.reduce((s, v) => s + v, 0) / m;
    const sigma = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / m);
    return { mean, sigma: sigma <= 1e-9 * Math.max(1, Math.abs(mean)) ? 0 : sigma };
  };
  const [sa, sb] = [stats(a), stats(b)];
  if (sa.sigma === 0 && sb.sigma === 0) return 0;
  if (sa.sigma === 0 || sb.sigma === 0) return Math.sqrt(m);
  let sum = 0;
  for (let k = 0; k < m; k++) sum += ((a[k] - sa.mean) / sa.sigma - (b[k] - sb.mean) / sb.sigma) ** 2;
  return Math.sqrt(sum);
}

/** A reproducible series: a daily pattern with some noise. */
function series(length: number, seed = 7): number[] {
  let state = seed;
  const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  return Array.from({ length }, (_, i) => 10 + 5 * Math.sin((i / 24) * 2 * Math.PI) + random() * 2);
}

const noContexts = (windows: number) => ({ of: new Int32Array(windows).fill(-1), count: 0 });

describe('the matrix profile', () => {
  it('is the distance to the nearest window outside the exclusion zone', () => {
    const x = series(150);
    const m = 12;
    const exclusion = Math.ceil(m / 4);
    const result = computeProfiles(Float64Array.from(x), m, noContexts(x.length - m + 1));
    for (let i = 0; i < result.windows; i++) {
      let best = Infinity;
      for (let j = 0; j < result.windows; j++) if (Math.abs(i - j) > exclusion) best = Math.min(best, distance(x, i, j, m));
      expect(result.profile[i]).toBeCloseTo(best, 6);
      expect(distance(x, i, result.index[i], m)).toBeCloseTo(best, 6);
    }
  });

  it('finds a repeated pattern as the motif and a unique spike as the discord', () => {
    const x = series(400).map((v) => v * 0.2);
    const pattern = [0, 3, 8, 3, 0, -3, -8, -3];
    pattern.forEach((v, k) => {
      x[50 + k] = v;
      x[250 + k] = v;
    });
    x[150] = 40;
    const { profile, index } = computeProfiles(Float64Array.from(x), 8, noContexts(393));
    const motif = profile.reduce((best, v, i) => (v < profile[best] ? i : best), 0);
    expect([50, 250]).toContain(motif);
    expect(index[50]).toBe(250);
    const discord = profile.reduce((best, v, i) => (v > profile[best] ? i : best), 0);
    expect(Math.abs(discord - 150)).toBeLessThan(8);
  });

  it('treats flat windows like a constant: zero apart, sqrt(m) from the others', () => {
    const x = [...Array(40).fill(5), ...series(40), ...Array(40).fill(5)];
    const m = 8;
    const result = computeProfiles(Float64Array.from(x), m, noContexts(x.length - m + 1));
    expect(result.profile[0]).toBe(0);
    expect(result.profile[100]).toBe(0);
    // a window that straddles the flat part and the pattern is never closer than it is to anything
    for (let i = 0; i < result.windows; i++) expect(result.profile[i]).toBeCloseTo(Math.min(...Array.from({ length: result.windows }, (_, j) => (Math.abs(i - j) > 2 ? distance(x, i, j, m) : Infinity))), 6);
  });

  it('skips the windows that contain a missing value', () => {
    const x = series(100);
    const m = 10;
    const withGap = Float64Array.from(x);
    withGap[40] = NaN;
    const result = computeProfiles(withGap, m, noContexts(91));
    for (let i = 31; i <= 40; i++) expect(Number.isNaN(result.profile[i])).toBe(true);
    expect(Number.isNaN(result.profile[30])).toBe(false);
    expect(result.index.every((j, i) => j < 0 || !(j >= 31 && j <= 40) || Number.isNaN(result.profile[i]))).toBe(true);
  });

  it('refuses a window of less than two values', () => {
    expect(() => computeProfiles(new Float64Array(10), 1, noContexts(10))).toThrow(RangeError);
  });

  it('reports its progress', () => {
    const seen: number[] = [];
    computeProfiles(Float64Array.from(series(300)), 10, noContexts(291), { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1]))).toBe(true);
  });
});

describe('missing values', () => {
  const x = Float64Array.from([NaN, 1, NaN, NaN, 4, 5, NaN]);
  it('can be left, counted as zero, or filled by a line, but not outside the series', () => {
    expect(fillGaps(x, 'none')).toBe(x);
    expect([...fillGaps(x, 'zero')]).toEqual([0, 1, 0, 0, 4, 5, 0]);
    expect([...fillGaps(x, 'linear')].map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, 1, 2, 3, 4, 5, null]);
    expect(Number.isNaN(x[0])).toBe(true);
  });

  it('give a series with only daytime values a profile once they are filled', () => {
    const day = Float64Array.from({ length: 24 * 6 }, (_, i) => (i % 24 >= 7 && i % 24 < 17 ? 50 + 40 * Math.sin(((i % 24) - 7) / 10 * Math.PI) : NaN));
    const strict = computeProfiles(day, 12, noContexts(24 * 6 - 11));
    expect(strict.profile.every((v) => Number.isNaN(v))).toBe(true);
    const filled = computeProfiles(fillGaps(day, 'zero'), 12, noContexts(24 * 6 - 11));
    expect(filled.profile.some((v) => !Number.isNaN(v))).toBe(true);
  });
});

describe('the grid and the contexts', () => {
  const times = (hours: number[]) => hours.map((h) => Date.UTC(2026, 0, 5) + h * HOUR);

  it('finds the sampling step, and puts the values on a regular grid with gaps as NaN', () => {
    const t = times([0, 1, 2, 4, 5]);
    expect(sampleStep(t)).toBe(HOUR);
    const grid = toGrid(t, [1, 2, 3, null, 5])!;
    expect(grid.step).toBe(HOUR);
    expect(grid.t0).toBe(t[0]);
    expect([...grid.values].map((v) => (Number.isNaN(v) ? null : v))).toEqual([1, 2, 3, null, null, 5]);
    expect(toGrid([1], [1])).toBeNull();
    expect(toGrid(t, [1, 2, 3, 4, 5], 3)).toBeNull();
  });

  it('makes a context per day, for the windows that start in its first steps', () => {
    const grid = { t0: Date.UTC(2026, 0, 5), step: HOUR, values: new Float64Array(24 * 4).fill(1) };
    const contexts = contextsOf(grid, 20, { period: 'day', shift: 2 });
    // windows start at 0..76: those at hours 0, 1, 2 of each day, while a window fits
    expect(contexts.count).toBe(4);
    expect([...contexts.of].filter((c) => c >= 0)).toHaveLength(3 * 3 + 3);
    expect(contexts.of[0]).toBe(0);
    expect(contexts.of[3]).toBe(-1);
    expect(contexts.of[24]).toBe(1);
    expect(contexts.starts[1] - contexts.starts[0]).toBe(DAY);
  });

  it('counts weeks from a Monday', () => {
    const monday = Date.UTC(2026, 0, 5);
    const grid = { t0: monday - 2 * DAY, step: DAY, values: new Float64Array(20).fill(1) };
    const contexts = contextsOf(grid, 3, { period: 'week', shift: 0 });
    expect(new Date(contexts.starts[0]).getUTCDay()).toBe(1);
    expect(contexts.of[0]).toBe(-1);
    expect(contexts.of[2]).toBeGreaterThanOrEqual(0);
  });
});

describe('the contextual matrix profile', () => {
  it('is the minimum over the windows of two contexts, the same both ways, and empty on the diagonal', () => {
    const days = 6;
    const m = 10;
    const x = series(24 * days, 11);
    const grid = { t0: Date.UTC(2026, 0, 5), step: HOUR, values: Float64Array.from(x) };
    const contexts = contextsOf(grid, m, { period: 'day', shift: 3 });
    const result = computeProfiles(grid.values, m, contexts);
    expect(contexts.count).toBe(days);
    for (let a = 0; a < days; a++) {
      for (let b = 0; b < days; b++) {
        const value = result.cmp[a * days + b];
        if (a === b) {
          expect(value).toBe(Infinity);
          continue;
        }
        let best = Infinity;
        for (let i = 0; i < contexts.of.length; i++) {
          if (contexts.of[i] !== a) continue;
          for (let j = 0; j < contexts.of.length; j++) if (contexts.of[j] === b) best = Math.min(best, distance(x, i, j, m));
        }
        expect(value).toBeCloseTo(best, 6);
        expect(result.cmp[b * days + a]).toBeCloseTo(value, 12);
        const [i, j] = [result.cmpWindows[2 * (a * days + b)], result.cmpWindows[2 * (a * days + b) + 1]];
        expect(contexts.of[i]).toBe(a);
        expect(contexts.of[j]).toBe(b);
        expect(distance(x, i, j, m)).toBeCloseTo(value, 6);
      }
    }
  });

  it('shows a day that differs from the others as the most deviating one', () => {
    const days = 8;
    const x: number[] = [];
    for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) x.push(d === 5 ? (h % 2) * 10 : Math.sin((h / 24) * 2 * Math.PI) * 10 + 0.05 * Math.sin(d * h));
    const grid = { t0: Date.UTC(2026, 0, 5), step: HOUR, values: Float64Array.from(x) };
    const contexts = contextsOf(grid, 20, { period: 'day', shift: 3 });
    const { cmp, count } = computeProfiles(grid.values, 20, contexts);
    const deviation = contextDeviation(cmp, count);
    expect(deviation.indexOf(Math.max(...deviation))).toBe(5);
  });
});
