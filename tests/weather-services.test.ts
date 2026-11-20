import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Source, parseRdf } from '../src/index.js';
import { parseApiTime } from '../scripts/geosphere.js';
import { parseTimestamp } from '../scripts/meteoswiss.js';

const examples = new URL('../examples/', import.meta.url).pathname;

/** The sources a script described, from its manifest: without reading their data. */
async function described(directory: string) {
  const manifest: { id: string; path: string[]; metadata: string }[] = JSON.parse(await readFile(join(examples, directory, 'manifest.json'), 'utf8'));
  return Promise.all(
    manifest.map(async (entry) => {
      const iri = `https://example.org/${directory}/${entry.metadata}`;
      const source = await Source.open(await parseRdf(await readFile(join(examples, directory, entry.metadata), 'utf8'), { baseIRI: iri }), { baseIRI: iri });
      return { entry, source };
    }),
  );
}

describe('the weather of MeteoSwiss and GeoSphere Austria', () => {
  it('reads the times of the files, which are no xsd:dateTime', () => {
    expect(parseTimestamp('19.11.2026 23:00')).toBe('2026-11-19T23:00:00Z');
    expect(parseTimestamp('01.01.1864 00:00')).toBe('1864-01-01T00:00:00Z');
    expect(parseTimestamp('2026-11-19T23:00')).toBeNull();
    expect(parseApiTime('2025-01-01T00:00+00:00')).toBe('2025-01-01T00:00:00Z');
    expect(parseApiTime('2025-06-30T23:00+02:00')).toBe('2025-06-30T21:00:00Z');
    expect(parseApiTime('2025-01-01 00:00')).toBeNull();
  });

  it('MeteoSwiss: static CSV files on data.geo.admin.ch on an hourly or daily grid, with the range of the temperature', async () => {
    const sources = await described('meteoswiss');
    expect(sources.length).toBeGreaterThanOrEqual(15);
    for (const { entry, source } of sources) {
      const m = source.metadata;
      expect(entry.path[0]).toBe('Switzerland · MeteoSwiss');
      expect(m.dataFile).toMatch(/^https:\/\/data\.geo\.admin\.ch\/ch\.meteoschweiz\.ogd-smn\/[a-z]+\/ogd-smn_[a-z]+_(h_historical_2020-2029|d_historical)\.csv$/);
      expect(m.delimiter).toBe(';');
      expect(['PT1H', 'P1D']).toContain(m.timeStep);
      const mean = m.fields.find((f) => f.columnName === (m.timeStep === 'PT1H' ? 'tre200h0' : 'tre200d0'));
      expect(mean?.unit).toBe('http://qudt.org/vocab/unit/DEG_C');
      // the minimum and the maximum describe the mean, with schema:minValue and schema:maxValue
      const range = m.fields.filter((f) => mean && f.describesField.includes(mean.id)).map((f) => f.property).sort();
      expect(range).toEqual(['https://schema.org/maxValue', 'https://schema.org/minValue']);
    }
  });

  it('GeoSphere Austria: the hours of 2025 from its dataset API, an immutable source', async () => {
    const sources = await described('geosphere');
    expect(sources.length).toBeGreaterThanOrEqual(8);
    for (const { entry, source } of sources) {
      const m = source.metadata;
      expect(entry.path[0]).toBe('Austria · GeoSphere');
      expect(m.dataFile).toMatch(/^https:\/\/dataset\.api\.hub\.geosphere\.at\/v1\/station\/historical\/klima-v2-1h\?/);
      expect(m.immutable).toBe(true);
      expect([m.timeBase, m.timeStep, m.from, m.until]).toEqual(['2025-01-01T00:00:00Z', 'PT1H', '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z']);
      expect(source.resolveField('tl').unit).toBe('http://qudt.org/vocab/unit/DEG_C');
    }
  });
});
