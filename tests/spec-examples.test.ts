import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Snippet, parseRdf, toRDFMessages, type Reading } from '../src/index.js';
import { startServer, type MockServer } from './helpers/server.js';
import { tempDir } from './helpers/fixtures.js';

const PREFIXES = `
@prefix tss: <https://w3id.org/tss#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix quantitykind: <http://qudt.org/vocab/quantitykind/> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix ex: <https://example.org/ex#> .
`;

const EXAMPLE_1 = `${PREFIXES}
ex:snippet
    a tss:EmbeddedRDFSnippet ;
    rdfs:label "Conductivity readings"@en ;
    tss:mutable true ;
    tss:committedUntil "2024-05-12T09:46:10Z"^^xsd:dateTimeStamp ;
    tss:producedBy ex:producer ;
    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    tss:until "2024-05-13T00:00:00Z"^^xsd:dateTimeStamp ;
    tss:timeField ex:time-field ;
    tss:key ex:time-field ;
    tss:hasField ex:time-field, ex:value-field .

ex:time-field a tss:Field ; rdfs:label "Observation time"@en ; tss:datatype xsd:dateTimeStamp .

ex:value-field
    a tss:Field ;
    rdfs:label "Electrical conductivity"@en ;
    tss:datatype xsd:double ;
    tss:minimum "0"^^xsd:double ;
    tss:maximum "10000"^^xsd:double ;
    tss:observedProperty quantitykind:ElectricConductivity ;
    tss:unit unit:MicroS-PER-CentiM ;
    tss:sensor ex:sensor-1 ;
    tss:featureOfInterest ex:feature-1 ;
    tss:summary [
        tss:missingValuePolicy tss:ExcludeEmptyValues ;
        tss:count "5"^^xsd:integer ;
        tss:missing "0"^^xsd:integer ;
        tss:firstTime "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
        tss:lastTime "2024-05-12T09:45:00Z"^^xsd:dateTimeStamp ;
        tss:observedMinimum "4719.3"^^xsd:double ;
        tss:observedMaximum "4810.5"^^xsd:double ;
        tss:mean "4757.54"^^xsd:double ;
        tss:median "4751.9"^^xsd:double ;
        tss:generatedAtTime "2024-05-12T09:46:10Z"^^xsd:dateTimeStamp
    ] .

ex:sensor-1 rdfs:label "Conductivity sensor" .

ex:snippet tss:hasPoint [ ex:time-field "2024-05-12T09:15:00Z"^^xsd:dateTimeStamp ; ex:value-field "4719.3"^^xsd:double ] .
ex:snippet tss:hasPoint [ ex:time-field "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; ex:value-field "4810.5"^^xsd:double ] .
ex:snippet tss:hasPoint [ ex:time-field "2024-05-12T08:15:00Z"^^xsd:dateTimeStamp ; ex:value-field "4722.4"^^xsd:double ] .
ex:snippet tss:hasPoint [ ex:time-field "2024-05-12T08:30:00Z"^^xsd:dateTimeStamp ; ex:value-field "4751.9"^^xsd:double ] .
ex:snippet tss:hasPoint [ ex:time-field "2024-05-12T09:45:00Z"^^xsd:dateTimeStamp ; ex:value-field "4783.6"^^xsd:double ] .
`;

const EXAMPLE_4 = `${PREFIXES}
ex:weather-snippet
    a tss:EmbeddedRDFSnippet ;
    rdfs:label "Weather station readings"@en ;
    tss:mutable false ;
    tss:committedUntil "2024-05-12T09:00:00Z"^^xsd:dateTimeStamp ;
    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    tss:until "2024-05-12T09:00:00Z"^^xsd:dateTimeStamp ;
    tss:timeField ex:weather-time-field ;
    tss:hasField ex:weather-time-field, ex:temperature-field, ex:humidity-field .
ex:weather-time-field a tss:Field ; tss:datatype xsd:dateTimeStamp .
ex:temperature-field a tss:Field ; tss:datatype xsd:double ;
    tss:observedProperty quantitykind:Temperature ; tss:unit unit:DEG_C ;
    tss:sensor ex:thermometer ; tss:featureOfInterest ex:outside-air .
ex:humidity-field a tss:Field ; tss:datatype xsd:double ; tss:minimum "0"^^xsd:double ; tss:maximum "100"^^xsd:double ;
    tss:observedProperty quantitykind:RelativeHumidity ; tss:unit unit:PERCENT_RH ;
    tss:sensor ex:hygrometer ; tss:featureOfInterest ex:outside-air .
ex:weather-snippet tss:hasPoint [ ex:weather-time-field "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; ex:temperature-field "18.2"^^xsd:double ; ex:humidity-field "61.0"^^xsd:double ] .
ex:weather-snippet tss:hasPoint [ ex:weather-time-field "2024-05-12T08:10:00Z"^^xsd:dateTimeStamp ; ex:temperature-field "18.4"^^xsd:double ] .
ex:weather-snippet tss:hasPoint [ ex:weather-time-field "2024-05-12T08:20:00Z"^^xsd:dateTimeStamp ; ex:temperature-field "18.9"^^xsd:double ; ex:humidity-field "59.5"^^xsd:double ] .
`;

const EXAMPLE_7 = `${PREFIXES}
ex:json-snippet
    a tss:EmbeddedJSONSnippet ;
    tss:mutable true ;
    tss:committedUntil "2024-05-12T09:46:10Z"^^xsd:dateTimeStamp ;
    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    tss:until "2024-05-13T00:00:00Z"^^xsd:dateTimeStamp ;
    tss:timeField ex:json-time-field ;
    tss:hasField ex:json-time-field, ex:json-value-field ;
    tss:points """[
        { "time": "2024-05-12T08:00:00Z", "value": "4810.5" },
        { "time": "2024-05-12T08:15:00Z", "value": "4722.4" },
        { "time": "2024-05-12T08:30:00Z", "value": 4751.9 },
        { "time": "2024-05-12T09:15:00Z", "value": null },
        { "time": "2024-05-12T09:45:00Z", "value": "4783.6" }
      ]"""^^rdf:JSON .
ex:json-time-field a tss:Field ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .
ex:json-value-field a tss:Field ; tss:columnName "value" ; tss:datatype xsd:double .
`;

const external = (cls: string, body: string) => `${PREFIXES}
ex:snippet a tss:${cls} ; tss:mutable false ;
    tss:committedUntil "2024-05-12T09:46:10Z"^^xsd:dateTimeStamp ;
${body}
`;

describe('examples of the specification', () => {
  let server: MockServer;
  let dir: string;
  let cleanup: () => Promise<void>;
  const open = async (name: string, turtle: string) => {
    await writeFile(join(dir, name), turtle);
    return Snippet.fetch(`${server.url}/${name}`);
  };
  const values = (readings: Reading[], field = 'value') => readings.map((r) => r.get(field)?.value);
  const all = async (it: AsyncIterable<Reading>) => {
    const out: Reading[] = [];
    for await (const r of it) out.push(r);
    return out;
  };

  beforeAll(async () => {
    ({ dir, cleanup } = await tempDir());
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data.csv'), 'time;value\n2024-05-01T00:00:00Z;12.5\n2024-05-01T00:15:00Z;\n2024-05-01T00:30:00Z;12.7\n');
    await writeFile(join(dir, 'data-no-header.csv'), '2024-05-01T00:00:00Z,12.5\n2024-05-01T00:15:00Z,12.7\n');
    await writeFile(join(dir, 'grid.csv'), 'step,value\n0,4810.5\n1,4722.4\n2,4751.9\n5,4719.3\n7,4783.6\n');
    await writeFile(join(dir, 'delta.csv'), 'time,value\n2024-05-12T08:00:00Z,60.5\n2024-05-12T08:15:00Z,-27.6\n');
    server = await startServer(dir);
  });
  afterAll(async () => {
    await server.close();
    await cleanup();
  });

  it('example 1: an embedded snippet is read in time order, with its metadata', async () => {
    const snippet = await open('example1.ttl', EXAMPLE_1);
    expect(snippet.id).toBe('https://example.org/ex#snippet');
    expect(snippet.metadata.fields.map((f) => f.localName)).toEqual(['time-field', 'value-field']);
    expect(snippet.metadata.labels).toEqual(['Conductivity readings']);
    const readings = await all(snippet.read());
    expect(readings.map((r) => r.time)).toEqual([
      '2024-05-12T08:00:00Z',
      '2024-05-12T08:15:00Z',
      '2024-05-12T08:30:00Z',
      '2024-05-12T09:15:00Z',
      '2024-05-12T09:45:00Z',
    ]);
    expect(values(readings, 'value-field')).toEqual(['4810.5', '4722.4', '4751.9', '4719.3', '4783.6']);
    expect(snippet.summary('value-field')).toMatchObject({ count: 5, observedMinimum: '4719.3', mean: '4757.54' });
    expect((await snippet.validate()).results).toEqual([]);
  });

  it('example 2: expands into SOSA observations', async () => {
    const snippet = await open('example2.ttl', EXAMPLE_1);
    const messages = [];
    for await (const message of toRDFMessages(snippet.read())) messages.push(message);
    expect(messages).toHaveLength(5);
    const turtle = await messages[0].serialize('application/n-triples');
    expect(turtle).toContain('<http://www.w3.org/ns/sosa/observedProperty> <http://qudt.org/vocab/quantitykind/ElectricConductivity>');
    expect(turtle).toContain('<http://www.w3.org/ns/sosa/madeBySensor> <https://example.org/ex#sensor-1>');
    expect(turtle).toContain('<http://www.w3.org/ns/sosa/hasFeatureOfInterest> <https://example.org/ex#feature-1>');
    expect(turtle).toContain('<http://qudt.org/schema/qudt/hasUnit> <http://qudt.org/vocab/unit/MicroS-PER-CentiM>');
    expect(turtle).toContain('<http://purl.org/dc/terms/source> <https://example.org/ex#snippet>');
    expect(turtle).toContain('"2024-05-12T08:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>');
    expect(turtle).toContain('"4810.5"^^<http://www.w3.org/2001/XMLSchema#double>');
    // the description of the IRIs used comes once, with the first message, and has no TSS terms
    expect(turtle).toContain('<https://example.org/ex#sensor-1> <http://www.w3.org/2000/01/rdf-schema#label> "Conductivity sensor"');
    expect(turtle).not.toContain('w3id.org/tss');
    expect(await messages[1].serialize('application/n-triples')).not.toContain('Conductivity sensor');
  });

  it('example 2: can repeat or leave out the description', async () => {
    const snippet = await open('example2b.ttl', EXAMPLE_1);
    const every = [];
    for await (const m of toRDFMessages(snippet.read(), { description: 'every' })) every.push(await m.serialize('application/n-triples'));
    expect(every.every((m) => m.includes('Conductivity sensor'))).toBe(true);
    const none = [];
    for await (const m of toRDFMessages(snippet.read(), { description: 'none' })) none.push(await m.serialize('application/n-triples'));
    expect(none.some((m) => m.includes('Conductivity sensor'))).toBe(false);
  });

  it('example 2: takes the unit and value as read, after a conversion', async () => {
    const snippet = await open('example2c.ttl', EXAMPLE_4);
    const messages = [];
    for await (const m of toRDFMessages(snippet.read({ unit: 'http://qudt.org/vocab/unit/DEG_F', fields: ['temperature-field'] }))) messages.push(m);
    const text = await messages[0].serialize('application/n-triples');
    expect(text).toContain('<http://qudt.org/schema/qudt/hasUnit> <http://qudt.org/vocab/unit/DEG_F>');
    expect(text).toContain('"64.76"^^<http://www.w3.org/2001/XMLSchema#double>');
    expect(text).not.toContain('DEG_C');
  });

  it('example 4: a point without a value gives no observation for that field', async () => {
    const snippet = await open('example4.ttl', EXAMPLE_4);
    const messages = [];
    for await (const m of toRDFMessages(snippet.read())) messages.push(m);
    expect(messages.map((m) => m.quads.filter((q) => q.predicate.value.endsWith('observedProperty')).length)).toEqual([2, 1, 2]);
    const readings = await all(snippet.read());
    expect(readings[1].get('humidity-field')).toBeUndefined();
  });

  it('example 7: reads JSON points, where a missing key and null are empty values', async () => {
    const snippet = await open('example7.ttl', EXAMPLE_7);
    const readings = await all(snippet.read());
    expect(values(readings, 'json-value-field')).toEqual(['4810.5', '4722.4', '4751.9', undefined, '4783.6']);
  });

  it('example 8: reads CSV with another delimiter, and an empty cell is an empty value', async () => {
    const snippet = await open(
      'example8.ttl',
      external(
        'CSVSnippet',
        `    tss:from "2024-05-01T00:00:00Z"^^xsd:dateTimeStamp ; tss:dataFile <data.csv> ; tss:delimiter ";" ;
    tss:timeField ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:Field ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:Field ; tss:columnName "value" ; tss:datatype xsd:double .`,
      ),
    );
    const readings = await all(snippet.read());
    expect(readings.map((r) => r.time)).toEqual(['2024-05-01T00:00:00Z', '2024-05-01T00:15:00Z', '2024-05-01T00:30:00Z']);
    expect(values(readings, 'v')).toEqual(['12.5', undefined, '12.7']);
  });

  it('example 9: finds the columns by index when there is no header line', async () => {
    const snippet = await open(
      'example9.ttl',
      external(
        'CSVSnippet',
        `    tss:dataFile <data-no-header.csv> ; tss:header false ; tss:timeField ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:Field ; tss:columnName "time" ; tss:columnIndex 0 ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:Field ; tss:columnName "value" ; tss:columnIndex 1 ; tss:datatype xsd:double .`,
      ),
    );
    expect(values(await all(snippet.read()), 'v')).toEqual(['12.5', '12.7']);
  });

  it('example 12: computes the times of a time grid; steps without a row have no reading', async () => {
    const snippet = await open(
      'example12.ttl',
      external(
        'CSVSnippet',
        `    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; tss:until "2024-05-13T00:00:00Z"^^xsd:dateTimeStamp ;
    tss:dataFile <grid.csv> ; tss:timeBase "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; tss:timeStep "PT15M"^^xsd:duration ;
    tss:timeField ex:t ; tss:stepField ex:s ; tss:key ex:t ; tss:hasField ex:t, ex:s, ex:v .
ex:t a tss:Field ; tss:datatype xsd:dateTimeStamp .
ex:s a tss:Field ; tss:columnName "step" ; tss:datatype xsd:integer .
ex:v a tss:Field ; tss:columnName "value" ; tss:datatype xsd:double .`,
      ),
    );
    const readings = await all(snippet.read());
    expect(readings.map((r) => r.time)).toEqual([
      '2024-05-12T08:00:00Z',
      '2024-05-12T08:15:00Z',
      '2024-05-12T08:30:00Z',
      '2024-05-12T09:15:00Z',
      '2024-05-12T09:45:00Z',
    ]);
    expect([...readings[0].fields()].map(([id]) => id)).toEqual(['https://example.org/ex#v']);
    expect((await snippet.validate()).results).toEqual([]);
  });

  it('example 13: decodes values stated as differences from a baseline, exactly', async () => {
    const snippet = await open(
      'example13.ttl',
      external(
        'CSVSnippet',
        `    tss:dataFile <delta.csv> ; tss:timeField ex:t ; tss:key ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:Field ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:Field ; tss:columnName "value" ; tss:datatype xsd:double ;
    tss:valueEncoding tss:DeltaFromBaseline ; tss:baseline "4750"^^xsd:double .`,
      ),
    );
    expect(values(await all(snippet.read()), 'v')).toEqual(['4810.5', '4722.4']);
  });

  it('only reads the rows in the time window of an external snippet', async () => {
    const snippet = await open(
      'window.ttl',
      external(
        'CSVSnippet',
        `    tss:from "2024-05-01T00:10:00Z"^^xsd:dateTimeStamp ; tss:until "2024-05-01T00:30:00Z"^^xsd:dateTimeStamp ;
    tss:dataFile <data.csv> ; tss:delimiter ";" ; tss:timeField ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:Field ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:Field ; tss:columnName "value" ; tss:datatype xsd:double .`,
      ),
    );
    expect((await all(snippet.read())).map((r) => r.time)).toEqual(['2024-05-01T00:15:00Z']);
  });

  it('refuses a local data file in a fetched document unless localFiles is set', async () => {
    const turtle = external(
      'CSVSnippet',
      `    tss:dataFile <file:///etc/hostname> ; tss:timeField ex:t ; tss:hasField ex:t .
ex:t a tss:Field ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .`,
    );
    await writeFile(join(dir, 'local.ttl'), turtle);
    const snippet = await Snippet.fetch(`${server.url}/local.ttl`);
    await expect(snippet.read().next()).rejects.toThrow(/local file/);
  });

  it('reports what does not conform', async () => {
    const snippet = await Snippet.open(
      await parseRdf(
        `${PREFIXES}
ex:s a tss:EmbeddedRDFSnippet ; tss:timeField ex:t ; tss:hasField ex:t, ex:v ; tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
  tss:until "2024-05-12T09:00:00Z"^^xsd:dateTimeStamp ; tss:dataFile <x.csv> .
ex:t a tss:Field ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:Field ; tss:datatype xsd:double .
ex:s tss:hasPoint [ ex:t "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; ex:v "twelve"^^xsd:double ] .
ex:s tss:hasPoint [ ex:t "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ] .
ex:s tss:hasPoint [ ex:t "2024-05-12T10:00:00Z"^^xsd:dateTimeStamp ; ex:v "1"^^xsd:integer ] .`,
      ),
    );
    const report = await snippet.validate();
    expect(report.conforms).toBe(false);
    const rules = report.results.map((r) => r.rule);
    expect(rules).toEqual(expect.arrayContaining(['mutable', 'committed-until', 'not-allowed', 'lexical-form', 'unique-time', 'window', 'value-datatype']));
  });
});
