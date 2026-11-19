import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Source, UnitConversionError, convertUnit, type Row } from '../src/index.js';
import { DEG_C, tempDir, weatherOptions, weatherReadings } from './helpers/fixtures.js';

const unit = (name: string) => `http://qudt.org/vocab/unit/${name}`;

describe('unit conversion with QUDT and eyemind', () => {
  it('converts between units of one dimension', async () => {
    expect(await convertUnit('8.4', DEG_C, unit('DEG_F'))).toBe('47.12');
    expect(await convertUnit('100', DEG_C, unit('K'))).toBe('373.15');
    expect(await convertUnit('0', unit('DEG_F'), DEG_C)).toBe('-17.7777777778');
    expect(await convertUnit('36', unit('KiloM-PER-HR'), unit('M-PER-SEC'))).toBe('10');
    expect(await convertUnit('1', unit('MI'), unit('KiloM'))).toBe('1.609344');
  });

  it('normalizes to the SI unit of the dimension with "qudt"', async () => {
    expect(await convertUnit('8.4', DEG_C, 'qudt')).toBe('281.55');
    expect(await convertUnit('50', unit('KiloM-PER-HR'), 'qudt')).toBe('13.8888888889');
  });

  it('refuses units of different dimensions and unknown units', async () => {
    await expect(convertUnit('1', DEG_C, unit('M'))).rejects.toThrow(UnitConversionError);
    await expect(convertUnit('1', DEG_C, unit('M'))).rejects.toThrow(/different dimensions/);
    await expect(convertUnit('1', 'https://example.org/furlong', unit('M'))).rejects.toThrow(/unknown unit/);
    await expect(convertUnit('abc', DEG_C, unit('K'))).rejects.toThrow(UnitConversionError);
  });

  describe('when reading', () => {
    let dir: string;
    let cleanup: () => Promise<void>;
    beforeAll(async () => {
      ({ dir, cleanup } = await tempDir());
      const source = await Source.create({ ...weatherOptions('CSV', 'units'), dataFile: join(dir, 'units.csv'), file: join(dir, 'units.ttl') });
      await source.append(weatherReadings);
      await source.close();
    });
    afterAll(() => cleanup());

    const read = async (options: Parameters<Awaited<ReturnType<typeof Source.open>>['read']>[0]) => {
      const source = await Source.open(join(dir, 'units.ttl'));
      const out: Row[] = [];
      for await (const r of source.read(options)) out.push(r);
      return out;
    };

    it('keeps the published text by default', async () => {
      const [first] = await read({});
      expect(first.get('temperature')).toMatchObject({ value: '8.4', unit: DEG_C });
    });

    it('converts to the QUDT normalized unit', async () => {
      const readings = await read({ unit: 'qudt' });
      expect(readings[0].get('temperature')).toMatchObject({ value: '281.55', unit: unit('K'), datatype: 'http://www.w3.org/2001/XMLSchema#double' });
      expect(readings[3].get('temperature')!.toNative()).toBe(282.15);
    });

    it('converts to a unit you choose, and leaves fields without a unit alone', async () => {
      const [first] = await read({ unit: unit('DEG_F') });
      expect(first.get('temperature')).toMatchObject({ value: '47.12', unit: unit('DEG_F') });
      expect(first.get('humidity')).toMatchObject({ value: '61', unit: undefined });
      expect(first.get('status')!.value).toBe('ok');
    });

    it('takes a unit per field, by local name or IRI, and leaves the other fields as published', async () => {
      const [first] = await read({ unit: { temperature: unit('DEG_F'), 'https://example.org/fields/humidity': 'qudt' } });
      expect(first.get('temperature')).toMatchObject({ value: '47.12', unit: unit('DEG_F') });
      expect(first.get('humidity')).toMatchObject({ value: '61' });
      const [other] = await read({ unit: { temperature: 'qudt' } });
      expect(other.get('temperature')).toMatchObject({ value: '281.55', unit: unit('K') });
    });

    it('throws for a unit of another dimension in a per-field choice, and for an unknown field', async () => {
      await expect(read({ unit: { temperature: unit('M') } })).rejects.toThrow(UnitConversionError);
      await expect(read({ unit: { nope: unit('K') } })).rejects.toThrow(/field/);
    });

    it('throws before reading when the target has another dimension', async () => {
      await expect(read({ unit: unit('M') })).rejects.toThrow(UnitConversionError);
    });
  });
});
