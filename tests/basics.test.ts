import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal.js';
import { isValidLexical, toNativeValue } from '../src/lexical.js';
import {
  durationToMs,
  formatInstant,
  formatTime,
  gridTime,
  instantOf,
  parseDuration,
  parseTime,
  tryInstantOf,
} from '../src/time.js';
import { parseCsv } from '../src/formats/csv.js';
import { csvLine } from '../src/writers/csv.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

describe('times', () => {
  it('requires a timezone and a real day', () => {
    expect(parseTime('2024-05-12T08:00:00Z')).not.toBeNull();
    expect(parseTime('2024-05-12T08:00:00+02:00')).not.toBeNull();
    expect(parseTime('2024-05-12T08:00:00')).toBeNull();
    expect(parseTime('2024-02-30T08:00:00Z')).toBeNull();
    expect(parseTime('2023-02-29T08:00:00Z')).toBeNull();
    expect(parseTime('2024-02-29T08:00:00Z')).not.toBeNull();
  });

  it('compares times as moments', () => {
    expect(instantOf('2024-05-12T08:00:00Z')).toBe(instantOf('2024-05-12T10:00:00+02:00'));
    expect(instantOf('2024-05-12T08:00:00+00:00')).toBe(instantOf('2024-05-12T08:00:00Z'));
    expect(instantOf('2024-05-12T08:00:00.000Z')).toBe(instantOf('2024-05-12T08:00:00Z'));
    expect(instantOf('2024-05-12T08:00:00.5Z')).toBeGreaterThan(instantOf('2024-05-12T08:00:00Z'));
    expect(tryInstantOf('nope')).toBeNull();
  });

  it('keeps nanoseconds', () => {
    expect(instantOf('1970-01-01T00:00:00.123456789Z')).toBe(123456789n);
    expect(formatInstant(123456789n)).toBe('1970-01-01T00:00:00.123456789Z');
    expect(formatInstant(1_715_500_800_000_000_000n)).toBe('2024-05-12T08:00:00Z');
  });

  it('handles dates before 1970', () => {
    expect(formatInstant(instantOf('1969-12-31T23:59:59Z'))).toBe('1969-12-31T23:59:59Z');
    expect(instantOf('1969-12-31T23:59:59Z')).toBe(-1_000_000_000n);
  });
});

describe('time grids', () => {
  const at = (base: string, step: string, n: number) => formatTime(gridTime(parseTime(base)!, parseDuration(step)!, BigInt(n)));

  it('steps a fixed duration', () => {
    expect(at('2024-05-12T08:00:00Z', 'PT15M', 5)).toBe('2024-05-12T09:15:00Z');
    expect(at('2024-05-12T08:00:00Z', 'PT15M', 7)).toBe('2024-05-12T09:45:00Z');
    expect(at('2024-05-12T08:00:00+02:00', 'PT1H', 3)).toBe('2024-05-12T11:00:00+02:00');
  });

  it('steps calendar months: a day past the end of a month becomes its last day', () => {
    expect(at('2021-01-31T00:00:00Z', 'P1M', 1)).toBe('2021-02-28T00:00:00Z');
    expect(at('2021-01-31T00:00:00Z', 'P1M', 2)).toBe('2021-03-31T00:00:00Z');
    expect(at('2024-01-31T00:00:00Z', 'P1M', 1)).toBe('2024-02-29T00:00:00Z');
    expect(at('2021-01-31T00:00:00+02:00', 'P1M', 1)).toBe('2021-02-28T00:00:00+02:00');
    expect(at('2020-11-15T00:00:00Z', 'P1Y2M', 1)).toBe('2022-01-15T00:00:00Z');
  });

  it('parses and measures durations', () => {
    expect(parseDuration('PT0.5S')).toMatchObject({ clockNs: 500_000_000n });
    expect(parseDuration('P')).toBeNull();
    expect(parseDuration('PT')).toBeNull();
    expect(durationToMs('PT30S')).toBe(30000);
    expect(durationToMs('P1DT1H')).toBe(90_000_000);
    expect(() => durationToMs('P1M')).toThrow();
  });
});

describe('exact decimals', () => {
  it('adds without floating point errors', () => {
    expect(Decimal.parse('4750')!.add(Decimal.parse('60.5')!).toString()).toBe('4810.5');
    expect(Decimal.parse('4750')!.add(Decimal.parse('-27.6')!).toString()).toBe('4722.4');
    expect(Decimal.parse('0.1')!.add(Decimal.parse('0.2')!).toString()).toBe('0.3');
    expect(Decimal.parse('1e3')!.toString()).toBe('1000');
    expect(Decimal.parse('-0.5')!.add(Decimal.parse('0.25')!).toString()).toBe('-0.25');
    expect(Decimal.parse('abc')).toBeNull();
  });
});

describe('lexical forms', () => {
  it('checks the datatypes of spec § 4.1', () => {
    expect(isValidLexical(`${XSD}double`, '4810.5')).toBe(true);
    expect(isValidLexical(`${XSD}double`, '1.2E3')).toBe(true);
    expect(isValidLexical(`${XSD}double`, 'INF')).toBe(true);
    expect(isValidLexical(`${XSD}double`, '12 ')).toBe(false);
    expect(isValidLexical(`${XSD}decimal`, '1e3')).toBe(false);
    expect(isValidLexical(`${XSD}integer`, '12')).toBe(true);
    expect(isValidLexical(`${XSD}integer`, '12.0')).toBe(false);
    expect(isValidLexical(`${XSD}byte`, '128')).toBe(false);
    expect(isValidLexical(`${XSD}unsignedInt`, '-1')).toBe(false);
    expect(isValidLexical(`${XSD}positiveInteger`, '0')).toBe(false);
    expect(isValidLexical(`${XSD}boolean`, '1')).toBe(true);
    expect(isValidLexical(`${XSD}boolean`, 'yes')).toBe(false);
    expect(isValidLexical(`${XSD}date`, '2024-02-30')).toBe(false);
    expect(isValidLexical(`${XSD}dateTimeStamp`, '2024-05-12T08:00:00')).toBe(false);
    expect(isValidLexical(`${XSD}dateTime`, '2024-05-12T08:00:00')).toBe(true);
    expect(isValidLexical(`${XSD}string`, 'anything')).toBe(true);
  });

  it('keeps a value exactly as written but converts it on request', () => {
    expect(toNativeValue(`${XSD}integer`, '42')).toBe(42);
    expect(toNativeValue(`${XSD}integer`, '9007199254740993')).toBe(9007199254740993n);
    expect(toNativeValue(`${XSD}double`, '2.50')).toBe(2.5);
    expect(toNativeValue(`${XSD}double`, '-INF')).toBe(-Infinity);
    expect(toNativeValue(`${XSD}boolean`, '1')).toBe(true);
    expect(toNativeValue(`${XSD}dateTimeStamp`, '2024-05-12T08:00:00Z')).toEqual(new Date('2024-05-12T08:00:00Z'));
    expect(toNativeValue(`${XSD}string`, ' 12 ')).toBe(' 12 ');
  });
});

describe('CSV', () => {
  async function rows(chunks: string[], delimiter = ',') {
    async function* gen() {
      yield* chunks;
    }
    const out = [];
    for await (const row of parseCsv(gen(), delimiter)) out.push(row);
    return out;
  }

  it('parses quotes, doubled quotes, delimiters and line breaks in cells', async () => {
    const parsed = await rows(['a,"b,c","say ""hi""","line\nbreak"\r\n1,,3,4\n']);
    expect(parsed.map((r) => r.cells)).toEqual([
      ['a', 'b,c', 'say "hi"', 'line\nbreak'],
      ['1', '', '3', '4'],
    ]);
    expect(parsed.every((r) => r.terminated)).toBe(true);
  });

  it('reads across chunk boundaries, with another delimiter and a BOM', async () => {
    const parsed = await rows(['\uFEFFt;va', 'lue\r', '\n1;"2', '"";3"\n'], ';');
    expect(parsed.map((r) => r.cells)).toEqual([['t', 'value'], ['1', '2";3']]);
  });

  it('marks a last row without a line break as not terminated and skips blank lines', async () => {
    const parsed = await rows(['a,b\n\n1,2']);
    expect(parsed.map((r) => [r.cells, r.terminated])).toEqual([
      [['a', 'b'], true],
      [['1', '2'], false],
    ]);
  });

  it('writes what it reads', async () => {
    const cells = ['plain', 'with,comma', 'with "quote"', 'two\nlines', '', ' padded '];
    const parsed = await rows([csvLine(cells)]);
    expect(parsed[0].cells).toEqual(cells);
    expect(csvLine(['a', undefined, 'b'], ';')).toBe('a;;b\n');
  });
});
