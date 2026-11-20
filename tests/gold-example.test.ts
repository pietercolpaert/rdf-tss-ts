import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Source, UnitConversionError, type ReadableSource, type Row } from '../src/index.js';
import { startServer, type MockServer } from './helpers/server.js';
import { tempDir } from './helpers/fixtures.js';

// The gold prices example of the playground, with its data file served here instead of GitHub.
const GITHUB = 'https://raw.githubusercontent.com/datasets/gold-prices/refs/heads/main/data/monthly-processed.csv';

describe('the gold prices example', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let server: MockServer;
  let source: ReadableSource;
  const all = async <T>(it: AsyncIterable<T>) => {
    const out: T[] = [];
    for await (const r of it) out.push(r);
    return out;
  };

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    server = await startServer(dir);
    const turtle = await readFile(new URL('../examples/gold-prices/monthly.ttl', import.meta.url), 'utf8');
    expect(turtle).toContain(GITHUB);
    await writeFile(join(dir, 'monthly.ttl'), turtle.replace(GITHUB, `${server.url}/monthly-processed.csv`));
    await writeFile(join(dir, 'monthly-processed.csv'), 'Date,Price\n1833-01-01,18.930\n1833-02-01,18.930\n1833-03-01,18.930\n');
    source = await Source.fetch(`${server.url}/monthly.ttl`);
  });
  afterAll(async () => {
    await server.close();
    await cleanup();
  });

  it('conforms, and puts every row at its month', async () => {
    expect((await source.validate()).results).toEqual([]);
    const rows: Row[] = await all(source.read());
    expect(rows.map((r) => [r.time, r.get('price')?.value, r.get('date')?.value])).toEqual([
      ['1833-01-01T00:00:00Z', '18.930', '1833-01-01'],
      ['1833-02-01T00:00:00Z', '18.930', '1833-02-01'],
      ['1833-03-01T00:00:00Z', '18.930', '1833-03-01'],
    ]);
  });

  it('states its unit as US dollar per troy ounce, made of the QUDT units, which is not converted', async () => {
    const unit = `${server.url}/monthly.ttl#USD-PER-OZ_TROY`;
    expect(source.resolveField('price').unit).toBe(unit);
    const factors = [...source.dataset.match(null, null, null)]
      .filter((q) => q.predicate.value === 'http://qudt.org/schema/qudt/hasUnit')
      .map((q) => q.object.value)
      .sort();
    expect(factors).toEqual(['http://qudt.org/vocab/unit/CCY_USD', 'http://qudt.org/vocab/unit/OZ_TROY']);
    // a currency has no fixed conversion: the price is not converted, rather than converted wrongly
    await expect(all(source.read({ unit: 'qudt' }))).rejects.toThrow(UnitConversionError);
    await expect(all(source.read({ unit: { price: 'http://qudt.org/vocab/unit/CCY_EUR' } }))).rejects.toThrow(UnitConversionError);
    // the observations a reasoner derives have the unit
    const [head, first] = await Promise.all((await all(source.expand({ align: 'sosa' }))).slice(0, 2).map((m) => m.serialize('application/n-triples')));
    expect(head).toContain(`<${unit}> <http://qudt.org/schema/qudt/symbol> "$/oz{Troy}"`);
    expect(first).toContain(`<http://qudt.org/schema/qudt/hasUnit> <${unit}>`);
  });
});
