import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Source, parseRdf } from '../src/index.js';
import { datatypeOf, gridStep, parseDay } from '../scripts/datahub.js';

const days = (...texts: string[]) => texts.map((t) => parseDay(t)!);
const root = new URL('../examples/datahub/', import.meta.url).pathname;

describe('describing the time series of the core datasets on GitHub', () => {
  it('finds the calendar grid that every row is on', () => {
    expect(gridStep(days('2020-01-15', '2020-02-15', '2020-03-15'))).toBe('P1M');
    expect(gridStep(days('1947-01-01', '1947-04-01', '1947-07-01'))).toBe('P3M');
    expect(gridStep(days('1984-12-31', '1985-12-31', '1986-12-31'))).toBe('P1Y');
    expect(gridStep(days('2010', '2020', '2030'))).toBe('P10Y');
    expect(gridStep(days('2020-02-27', '2020-02-28', '2020-02-29', '2020-03-01'))).toBe('P1D');
    // a gap, a step back, or months of different days are no grid
    expect(gridStep(days('2020-01-01', '2020-02-01', '2020-04-01'))).toBeNull();
    expect(gridStep(days('2020-03-01', '2020-02-01', '2020-01-01'))).toBeNull();
    expect(gridStep(days('2020-01-31', '2020-02-29', '2020-03-31'))).toBeNull();
  });

  it('gives a column the narrowest numeric datatype, and none to text', () => {
    expect(datatypeOf(['1', '', '-2'])).toBe('xsd:integer');
    expect(datatypeOf(['1', '2.50'])).toBe('xsd:decimal');
    expect(datatypeOf(['1.5e3', 'NaN'])).toBe('xsd:double');
    expect(datatypeOf(['1', 'n/a'])).toBeNull();
  });

  it('every description is a time grid without a step field, and defines the units it makes', async () => {
    const manifest: { metadata: string }[] = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    expect(manifest.length).toBeGreaterThanOrEqual(40);
    for (const { metadata } of manifest) {
      const iri = `https://example.org/datahub/${metadata}`;
      const dataset = await parseRdf(await readFile(join(root, metadata), 'utf8'), { baseIRI: iri });
      const source = await Source.open(dataset, { baseIRI: iri });
      const m = source.metadata;
      expect(m.dataFile, metadata).toMatch(/^https:\/\/raw\.githubusercontent\.com\/datasets\//);
      expect(m.timeBase && m.timeStep && !m.stepField, metadata).toBe(true);
      for (const f of m.fields) {
        if (!f.unit || f.unit.startsWith('http://qudt.org/vocab/unit/')) continue;
        const symbols = [...dataset.match(null, null, null)].filter((q) => q.subject.value === f.unit && q.predicate.value === 'http://qudt.org/schema/qudt/symbol');
        expect(symbols, `${metadata}: ${f.unit}`).toHaveLength(1);
      }
    }
  });
});
