import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateOptions, RowInput } from '../../src/index.js';

export async function tempDir(): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'rdf-tss-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const ex = 'https://example.org/';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const DEG_C = 'http://qudt.org/vocab/unit/DEG_C';

/** A small weather source: a double with a unit, an integer, a string, and a missing value. */
export function weatherOptions(kind: CreateOptions['kind'], name: string): CreateOptions {
  return {
    id: `${ex}${name}#source`,
    kind,
    label: 'Weather',
    timeField: { id: `${ex}fields/time`, columnName: 'time' },
    fields: [
      {
        id: `${ex}fields/temperature`,
        columnName: 'temp',
        datatype: `${XSD}double`,
        observedProperty: 'http://qudt.org/vocab/quantitykind/Temperature',
        unit: DEG_C,
        sensor: `${ex}sensors/s1`,
        featureOfInterest: `${ex}outside-air`,
      },
      { id: `${ex}fields/humidity`, columnName: 'hum', datatype: `${XSD}integer` },
      { id: `${ex}fields/status`, columnName: 'status', datatype: `${XSD}string` },
    ],
  };
}

export const weatherReadings: RowInput[] = [
  { time: '2026-11-17T12:00:00Z', values: { temperature: '8.4', humidity: '61', status: 'ok' } },
  { time: '2026-11-17T12:10:00Z', values: { temperature: '8.6', status: 'estimated' } },
  { time: '2026-11-17T12:20:00Z', values: { temperature: '8.5', humidity: '59' } },
  { time: '2026-11-17T12:30:00Z', values: { temperature: '9', humidity: '58', status: 'ok' } },
];

/** What `read()` should give for `weatherReadings`, as `[time, temperature, humidity, status]`. */
export const weatherExpected: [string, string?, string?, string?][] = [
  ['2026-11-17T12:00:00Z', '8.4', '61', 'ok'],
  ['2026-11-17T12:10:00Z', '8.6', undefined, 'estimated'],
  ['2026-11-17T12:20:00Z', '8.5', '59', undefined],
  ['2026-11-17T12:30:00Z', '9', '58', 'ok'],
];
