import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Source, parseRdf } from '../src/index.js';
import { GEOS, parsePeriod, type EurostatExample } from '../scripts/eurostat.js';

const root = new URL('../examples/eurostat/', import.meta.url).pathname;

describe('describing the time series of Eurostat', () => {
  it('reads the periods of SDMX-CSV as the start of the period, numbered so consecutive ones follow each other', () => {
    expect(parsePeriod('2025')).toEqual({ freq: 'A', index: 2025, start: '2025-01-01' });
    expect(parsePeriod('2025-S2')).toMatchObject({ freq: 'S', start: '2025-07-01' });
    expect(parsePeriod('2025-Q3')).toMatchObject({ freq: 'Q', start: '2025-07-01' });
    expect(parsePeriod('2025-10')).toMatchObject({ freq: 'M', start: '2025-10-01' });
    expect(parsePeriod('2025-Q4')!.index + 1).toBe(parsePeriod('2026-Q1')!.index);
    expect(parsePeriod('2025-12')!.index + 1).toBe(parsePeriod('2026-01')!.index);
    // an ISO 8601 week starts on Monday; week 1 holds 4 January
    expect(parsePeriod('2000-W01')!.start).toBe('2000-01-03');
    expect(parsePeriod('2021-W01')!.start).toBe('2021-01-04');
    // 2020 has 53 weeks, 2021 has 52: W53 of 2020 comes right before W01 of 2021
    expect(parsePeriod('2020-W53')!.index + 1).toBe(parsePeriod('2021-W01')!.index);
    expect(parsePeriod('2021-W52')!.index + 1).toBe(parsePeriod('2022-W01')!.index);
    expect(parsePeriod('2021-W53')).toBeNull();
    expect(parsePeriod('2025-13')).toBeNull();
    expect(parsePeriod('2025-10-01')).toBeNull();
  });

  it('every description is a time grid over the API of Eurostat, about a country of Wikidata', async () => {
    const manifest: EurostatExample[] = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    expect(manifest.length).toBeGreaterThan(80);
    const ids = new Set(manifest.map((e) => e.id));
    expect(ids.size).toBe(manifest.length);
    for (const entry of manifest) {
      expect(entry.path[0]).toBe('Europe · Eurostat');
      const turtle = await readFile(join(root, entry.metadata), 'utf8');
      const source = await Source.open(await parseRdf(turtle, { baseIRI: `https://example.org/${entry.metadata}` }));
      const m = source.metadata;
      expect(m.kind).toBe('CSV');
      expect(m.dataFile).toMatch(/^https:\/\/ec\.europa\.eu\/eurostat\/api\/dissemination\/sdmx\/2\.1\/data\/[a-z_0-9]+\/[^?]+\?format=SDMX-CSV$/);
      expect(m.timeBase).toMatch(/T00:00:00Z$/);
      expect(['P1Y', 'P6M', 'P3M', 'P1M', 'P7D']).toContain(m.timeStep);
      expect(m.stepField).toBeUndefined();
      const value = source.resolveField('value');
      expect(value.columnName).toBe('OBS_VALUE');
      const country = Object.values(GEOS).find((g) => g.name === entry.path[2])!;
      expect(value.featureOfInterest).toBe(`http://www.wikidata.org/entity/${country.wikidata}`);
      // a flag describes the value it is on
      const flag = m.fields.find((f) => f.columnName === 'OBS_FLAG');
      if (flag) expect(flag.describesField).toEqual([value.id]);
      // validate() would read the data from Eurostat: scripts/eurostat.ts does that when it writes them
    }
  });
});
