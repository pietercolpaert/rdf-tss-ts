import { describe, expect, it } from 'vitest';
import { timeTicks } from '../playground/chart.js';

const year = (t: number) => new Date(t).getUTCFullYear();

describe('the time axis of the playground charts', () => {
  it('puts the ticks of a long series on round years, on the first of January', () => {
    const ticks = timeTicks(Date.UTC(1833, 0, 1), Date.UTC(2026, 9, 1), 8);
    expect(ticks.map(year)).toEqual([1850, 1875, 1900, 1925, 1950, 1975, 2000, 2025]);
    for (const t of ticks) expect(new Date(t).toISOString()).toMatch(/^\d{4}-01-01T00:00:00/);
    // a few years: every year
    expect(timeTicks(Date.UTC(2020, 5, 1), Date.UTC(2026, 5, 1), 8).map(year)).toEqual([2021, 2022, 2023, 2024, 2025, 2026]);
  });

  it('keeps hours and days for short series', () => {
    const day = 86_400_000;
    const ticks = timeTicks(Date.UTC(2026, 10, 17), Date.UTC(2026, 10, 18), 8);
    expect(ticks[1] - ticks[0]).toBe(3 * 3_600_000);
    expect(timeTicks(Date.UTC(2026, 0, 1), Date.UTC(2026, 4, 1), 8).every((t, i, all) => i === 0 || t - all[i - 1] === 30 * day)).toBe(true);
  });
});
