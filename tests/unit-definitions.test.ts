import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Source, UnitConversionError, type ReadableSource, type Row } from '../src/index.js';
import { tempDir } from './helpers/fixtures.js';

// Units that the metadata defines itself are converted with eyemind too, and a standard
// uncertainty, a difference of values, is converted without the offset of its unit.

const turtle = `
@prefix tss: <https://w3id.org/tss#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix qkdv: <http://qudt.org/vocab/dimensionvector/> .
<#source> a tss:CSVSource ; tss:immutable true ; tss:dataFile <data.csv> ;
    tss:timeField <#time> ; tss:hasField <#time>, <#anomaly>, <#temp>, <#temp-u>, <#density>, <#price> .
<#time> a tss:ContextField ; tss:columnName "time" ; tss:datatype xsd:dateTime .
<#anomaly> a tss:ValueField ; tss:columnName "anomaly" ; tss:datatype xsd:decimal ; tss:unit <#DEG_C-DIFF> .
<#temp> a tss:ValueField ; tss:columnName "temp" ; tss:datatype xsd:decimal ; tss:unit unit:DEG_C .
<#temp-u> a tss:ContextField ; tss:columnName "temp-u" ; tss:datatype xsd:decimal ; tss:unit unit:DEG_C ;
    tss:describesField <#temp> ; tss:property qudt:standardUncertainty .
<#density> a tss:ValueField ; tss:columnName "density" ; tss:datatype xsd:decimal ; tss:unit <#TONNE-PER-M3> .
<#price> a tss:ValueField ; tss:columnName "price" ; tss:datatype xsd:decimal ; tss:unit <#USD-PER-TONNE> .
<#DEG_C-DIFF> a qudt:Unit ; qudt:hasDimensionVector qkdv:A0E0L0I0M0H1T0D0 ; qudt:conversionMultiplier 1.0 ; qudt:conversionOffset 0.0 .
<#TONNE-PER-M3> a qudt:DerivedUnit ;
    qudt:hasFactorUnit [ a qudt:FactorUnit ; qudt:exponent 1 ; qudt:hasUnit unit:TONNE ], [ a qudt:FactorUnit ; qudt:exponent -1 ; qudt:hasUnit unit:M3 ] .
<#USD-PER-TONNE> a qudt:DerivedUnit ;
    qudt:hasFactorUnit [ a qudt:FactorUnit ; qudt:exponent 1 ; qudt:hasUnit unit:CCY_USD ], [ a qudt:FactorUnit ; qudt:exponent -1 ; qudt:hasUnit unit:TONNE ] .
`;

describe('units the metadata defines, and uncertainties', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let source: ReadableSource;
  const all = async (it: AsyncIterable<Row>) => {
    const out: Row[] = [];
    for await (const r of it) out.push(r);
    return out;
  };
  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    await writeFile(join(dir, 'data.csv'), 'time,anomaly,temp,temp-u,density,price\n2030-01-01T00:00:00Z,0.5,20,0.5,1.2,90\n');
    await writeFile(join(dir, 'units.ttl'), turtle);
    source = await Source.open(join(dir, 'units.ttl'), { localFiles: true });
  });
  afterAll(() => cleanup());

  it('conforms', async () => {
    expect((await source.validate()).results).toEqual([]);
  });

  it('converts a temperature difference of the metadata 1:1 to kelvin, without an offset', async () => {
    const [row] = await all(source.read({ unit: { anomaly: 'qudt' } }));
    expect(row.get('anomaly')?.value).toBe('0.5');
    expect(row.get('anomaly')?.unit).toBe('http://qudt.org/vocab/unit/K');
  });

  it('converts a unit made of QUDT units with qudt:hasFactorUnit', async () => {
    const [row] = await all(source.read({ unit: { density: 'qudt' } }));
    expect(row.get('density')?.value).toBe('1200');
    expect(row.get('density')?.unit).toBe('http://qudt.org/vocab/unit/KiloGM-PER-M3');
  });

  it('converts a standard uncertainty with the scale of its unit only', async () => {
    const [row] = await all(source.read({ unit: { temp: 'http://qudt.org/vocab/unit/K', 'temp-u': 'http://qudt.org/vocab/unit/K' } }));
    expect(row.get('temp')?.value).toBe('293.15');
    expect(row.get('temp-u')?.value).toBe('0.5');
    const [fahrenheit] = await all(source.read({ unit: { 'temp-u': 'http://qudt.org/vocab/unit/DEG_F' } }));
    expect(fahrenheit.get('temp-u')?.value).toBe('0.9');
  });

  it('still refuses a unit with a currency in it', async () => {
    await expect(all(source.read({ unit: { price: 'qudt' } }))).rejects.toThrow(UnitConversionError);
  });
});
