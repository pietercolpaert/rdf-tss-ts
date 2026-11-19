import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Source, parseRdf, toRDFMessages, type RDFMessage, type Row } from '../src/index.js';
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

const TSS = 'https://w3id.org/tss#';
const EX = 'https://example.org/ex#';

// The embedded example of the specification: a growing source, written as an RDF Message Log.
const EMBEDDED_EXAMPLE = `VERSION "1.2-messages"
PREFIX tss: <https://w3id.org/tss#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX quantitykind: <http://qudt.org/vocab/quantitykind/>
PREFIX unit: <http://qudt.org/vocab/unit/>
PREFIX ex: <https://example.org/ex#>

ex:source
    a tss:EmbeddedRDFSource ;
    rdfs:label "Conductivity readings"@en ;
    tss:producedBy ex:producer ;
    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    tss:until "2024-05-13T00:00:00Z"^^xsd:dateTimeStamp ;
    tss:timeField ex:time-field ;
    tss:key ex:time-field ;
    tss:hasField ex:time-field,
        ex:value-field .

ex:time-field
    a tss:MetaField ;
    rdfs:label "Observation time"@en ;
    tss:datatype xsd:dateTimeStamp .

ex:value-field
    a tss:ValueField ;
    rdfs:label "Electrical conductivity"@en ;
    tss:property ex:conductivity ;
    tss:datatype xsd:double ;
    tss:minimum "0"^^xsd:double ;
    tss:maximum "10000"^^xsd:double ;
    tss:observedProperty quantitykind:ElectricConductivity ;
    tss:unit unit:MicroS-PER-CentiM ;
    tss:sensor ex:sensor-1 ;
    tss:featureOfInterest ex:feature-1 .

ex:conductivity
    rdfs:subPropertyOf tss:value .
MESSAGE
ex:source tss:hasPoint [
    tss:time "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    ex:conductivity "4810.5"^^xsd:double
] .
MESSAGE
ex:source tss:hasPoint [
    tss:time "2024-05-12T08:15:00Z"^^xsd:dateTimeStamp ;
    ex:conductivity "4722.4"^^xsd:double
] .
MESSAGE
ex:source tss:hasPoint [
    tss:time "2024-05-12T08:30:00Z"^^xsd:dateTimeStamp ;
    ex:conductivity "4751.9"^^xsd:double
] .
MESSAGE
ex:source tss:hasPoint [
    tss:time "2024-05-12T09:15:00Z"^^xsd:dateTimeStamp ;
    ex:conductivity "4719.3"^^xsd:double
] .
MESSAGE
ex:source tss:hasPoint [
    tss:time "2024-05-12T09:45:00Z"^^xsd:dateTimeStamp ;
    ex:conductivity "4783.6"^^xsd:double
] .
MESSAGE
`;

// The last message of the embedded example: it ends the source and adds the summary.
const ENDING_MESSAGE = `ex:source tss:immutable true .

ex:value-field tss:summary [
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
MESSAGE
`;

const MULTI_SENSOR = `${PREFIXES}
ex:weather-source
    a tss:EmbeddedRDFSource ;
    rdfs:label "Weather station readings"@en ;
    tss:immutable true ;
    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    tss:until "2024-05-12T09:00:00Z"^^xsd:dateTimeStamp ;
    tss:timeField ex:weather-time-field ;
    tss:hasField ex:weather-time-field,
        ex:temperature-field,
        ex:humidity-field .

ex:weather-time-field
    a tss:MetaField ;
    tss:datatype xsd:dateTimeStamp .

ex:temperature-field
    a tss:ValueField ;
    tss:property ex:temperature ;
    tss:datatype xsd:double ;
    tss:observedProperty quantitykind:Temperature ;
    tss:unit unit:DEG_C ;
    tss:sensor ex:thermometer ;
    tss:featureOfInterest ex:outside-air .

ex:humidity-field
    a tss:ValueField ;
    tss:property ex:humidity ;
    tss:datatype xsd:double ;
    tss:minimum "0"^^xsd:double ;
    tss:maximum "100"^^xsd:double ;
    tss:observedProperty quantitykind:RelativeHumidity ;
    tss:unit unit:PERCENT_RH ;
    tss:sensor ex:hygrometer ;
    tss:featureOfInterest ex:outside-air .

ex:weather-source tss:hasPoint [
    tss:time "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    ex:temperature "18.2"^^xsd:double
], [
    tss:time "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    ex:humidity "61.0"^^xsd:double
] .

ex:weather-source tss:hasPoint [
    tss:time "2024-05-12T08:10:00Z"^^xsd:dateTimeStamp ;
    ex:temperature "18.4"^^xsd:double
] .

ex:weather-source tss:hasPoint [
    tss:time "2024-05-12T08:20:00Z"^^xsd:dateTimeStamp ;
    ex:temperature "18.9"^^xsd:double
], [
    tss:time "2024-05-12T08:20:00Z"^^xsd:dateTimeStamp ;
    ex:humidity "59.5"^^xsd:double
] .
`;

const DESCRIBING = `${PREFIXES}
ex:two-series-source
    a tss:EmbeddedRDFSource ;
    tss:immutable true ;
    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    tss:until "2024-05-13T00:00:00Z"^^xsd:dateTimeStamp ;
    tss:timeField ex:two-series-time-field ;
    tss:key ex:two-series-time-field ;
    tss:hasField ex:two-series-time-field,
        ex:two-series-value-field,
        ex:two-series-status-field .

ex:two-series-time-field
    a tss:MetaField ;
    tss:datatype xsd:dateTimeStamp .

ex:two-series-value-field
    a tss:ValueField ;
    tss:property ex:conductivity ;
    tss:datatype xsd:double ;
    tss:observedProperty quantitykind:ElectricConductivity ;
    tss:unit unit:MicroS-PER-CentiM .

ex:two-series-status-field
    a tss:MetaField ;
    tss:property ex:status ;
    tss:datatype xsd:string ;
    tss:describesField ex:two-series-value-field .

ex:two-series-source tss:hasPoint [
    tss:time "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    ex:conductivity "4810.5"^^xsd:double ;
    ex:status "ok"^^xsd:string
] .

ex:two-series-source tss:hasPoint [
    tss:time "2024-05-12T08:15:00Z"^^xsd:dateTimeStamp ;
    ex:conductivity "4722.4"^^xsd:double ;
    ex:status "estimated"^^xsd:string
] .
`;

const JSON_ROWS = (rows: string) => `${PREFIXES}
ex:json-source
    a tss:EmbeddedJSONSource ;
    tss:immutable false ;
    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
    tss:until "2024-05-13T00:00:00Z"^^xsd:dateTimeStamp ;
    tss:timeField ex:json-time-field ;
    tss:hasField ex:json-time-field,
        ex:json-value-field ;
    tss:points """${rows}"""^^rdf:JSON .

ex:json-time-field
    a tss:MetaField ;
    tss:columnName "time" ;
    tss:datatype xsd:dateTimeStamp .

ex:json-value-field
    a tss:ValueField ;
    tss:columnName "value" ;
    tss:datatype xsd:double .
`;

const external = (cls: string, body: string) => `${PREFIXES}
ex:source a tss:${cls} ; tss:immutable true ;
${body}
`;

const CSV_EXAMPLE = `${PREFIXES}
ex:csv-source
    a tss:CSVSource ;
    tss:immutable true ;
    tss:from "2024-05-01T00:00:00Z"^^xsd:dateTimeStamp ;
    tss:dataFile <data.csv> ;
    tss:delimiter ";" ;
    tss:timeField ex:csv-time-field ;
    tss:hasField ex:csv-time-field,
        ex:csv-value-field .

ex:csv-time-field
    a tss:MetaField ;
    tss:columnName "time" ;
    tss:datatype xsd:dateTimeStamp .

ex:csv-value-field
    a tss:ValueField ;
    tss:columnName "value" ;
    tss:datatype xsd:double .
`;

describe('examples of the specification', () => {
  let server: MockServer;
  let dir: string;
  let cleanup: () => Promise<void>;
  const open = async (name: string, turtle: string) => {
    await writeFile(join(dir, name), turtle);
    return Source.fetch(`${server.url}/${name}`);
  };
  const values = (rows: Row[], field = 'value') => rows.map((r) => r.get(field)?.value);
  const all = async <T>(it: AsyncIterable<T>) => {
    const out: T[] = [];
    for await (const r of it) out.push(r);
    return out;
  };
  const ntriples = async (messages: RDFMessage[]) => Promise.all(messages.map((m) => m.serialize('application/n-triples')));

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

  it('the embedded example: an RDF Message Log of points, read in time order with the field property', async () => {
    const source = await open('embedded.ttl', EMBEDDED_EXAMPLE);
    expect(source.id).toBe(`${EX}source`);
    expect(source.metadata.immutable).toBe(false);
    expect(source.metadata.labels).toEqual(['Conductivity readings']);
    expect(source.metadata.fields.map((f) => [f.localName, f.kind, f.property, f.defaultProperty])).toEqual([
      ['time-field', 'meta', `${TSS}time`, true],
      ['value-field', 'value', `${EX}conductivity`, false],
    ]);
    const rows = await all(source.read());
    expect(rows.map((r) => r.time)).toEqual([
      '2024-05-12T08:00:00Z',
      '2024-05-12T08:15:00Z',
      '2024-05-12T08:30:00Z',
      '2024-05-12T09:15:00Z',
      '2024-05-12T09:45:00Z',
    ]);
    expect(values(rows, 'value-field')).toEqual(['4810.5', '4722.4', '4751.9', '4719.3', '4783.6']);
    expect((await source.validate()).results).toEqual([]);
  });

  it('the ending message makes the source immutable and adds the summary', async () => {
    const source = await open('ended.ttl', EMBEDDED_EXAMPLE + ENDING_MESSAGE);
    expect(source.metadata.immutable).toBe(true);
    expect(source.summary('value-field')).toMatchObject({ count: 5, observedMinimum: '4719.3', mean: '4757.54' });
    expect((await source.validate()).results).toEqual([]);
  });

  it('the expanded point: each point links to its field, and the time field gets its default property', async () => {
    const source = await open('expanded.ttl', EMBEDDED_EXAMPLE);
    const messages = await all(source.expand());
    expect(messages).toHaveLength(6);
    const [head, first] = await ntriples(messages.slice(0, 2));
    expect(head).toContain(`<${EX}time-field> <${TSS}property> <${TSS}time>`);
    // ex:conductivity is the publisher's own property: the expansion does not align it, the metadata does
    expect(head.match(/<https:\/\/example.org\/ex#value-field> <https:\/\/w3id.org\/tss#property>/g)).toHaveLength(1);
    expect(head).toContain(`<${EX}conductivity> <http://www.w3.org/2000/01/rdf-schema#subPropertyOf> <${TSS}value>`);
    expect(head).not.toContain(`<${TSS}hasPoint>`);
    expect(first).toContain(`<${EX}source> <${TSS}hasPoint> _:`);
    expect(first).toContain(`<${TSS}field> <${EX}value-field>`);
    expect(first).toContain(`<${TSS}time> "2024-05-12T08:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp>`);
    expect(first).toContain(`<${EX}conductivity> "4810.5"^^<http://www.w3.org/2001/XMLSchema#double>`);
    expect(first).not.toContain('sosa');
  });

  it('the derived observation: with align, the expansion also writes what a reasoner derives', async () => {
    const source = await open('derived.ttl', EMBEDDED_EXAMPLE);
    const [, first] = await ntriples(await all(source.expand({ align: ['sosa', 'saref'] })));
    const SOSA = 'http://www.w3.org/ns/sosa/';
    expect(first).toContain(`<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${SOSA}Observation>`);
    expect(first).toContain(`<${SOSA}resultTime> "2024-05-12T08:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp>`);
    expect(first).toContain(`<${SOSA}hasSimpleResult> "4810.5"^^<http://www.w3.org/2001/XMLSchema#double>`);
    expect(first).toContain(`<${SOSA}observedProperty> <http://qudt.org/vocab/quantitykind/ElectricConductivity>`);
    expect(first).toContain(`<${SOSA}madeBySensor> <${EX}sensor-1>`);
    expect(first).toContain(`<${SOSA}hasFeatureOfInterest> <${EX}feature-1>`);
    expect(first).toContain('<http://qudt.org/schema/qudt/hasUnit> <http://qudt.org/vocab/unit/MicroS-PER-CentiM>');
    expect(first).toContain('<https://saref.etsi.org/core/hasValue> "4810.5"');
    expect(first).toContain('<https://saref.etsi.org/core/isMeasuredIn> <http://qudt.org/vocab/unit/MicroS-PER-CentiM>');
  });

  it('a property the publisher does not align is not a result', async () => {
    const source = await open('unaligned.ttl', EMBEDDED_EXAMPLE.replace('ex:conductivity\n    rdfs:subPropertyOf tss:value .\n', ''));
    const [, first] = await ntriples(await all(source.expand({ align: 'sosa' })));
    expect(first).toContain('<http://www.w3.org/ns/sosa/resultTime>');
    expect(first).not.toContain('hasSimpleResult');
  });

  it('the multi-sensor example: three rows of five points, one row without humidity', async () => {
    const source = await open('multi.ttl', MULTI_SENSOR);
    const rows = await all(source.read());
    expect(rows.map((r) => r.time)).toEqual(['2024-05-12T08:00:00Z', '2024-05-12T08:10:00Z', '2024-05-12T08:20:00Z']);
    expect(values(rows, 'temperature-field')).toEqual(['18.2', '18.4', '18.9']);
    expect(values(rows, 'humidity-field')).toEqual(['61.0', undefined, '59.5']);
    const messages = await all(toRDFMessages(source.read(), { metadata: false }));
    expect(messages.map((m) => m.quads.filter((q) => q.predicate.value === `${TSS}hasPoint`).length)).toEqual([2, 1, 2]);
    expect((await source.validate()).results).toEqual([]);
  });

  it('the describing field: the status is read with its row, and stated on the point of the value', async () => {
    const source = await open('describing.ttl', DESCRIBING);
    expect(source.metadata.fields.map((f) => f.kind)).toEqual(['meta', 'value', 'meta']);
    const rows = await all(source.read());
    expect(values(rows, 'two-series-status-field')).toEqual(['ok', 'estimated']);
    const [, first] = await ntriples(await all(source.expand()));
    expect(first).toMatch(/_:(\S+) <https:\/\/example.org\/ex#status> "ok"/);
    expect(first.match(/<https:\/\/w3id.org\/tss#hasPoint>/g)).toHaveLength(1);
    expect((await source.validate()).results).toEqual([]);
  });

  it('the JSON rows: the default field property is made from the metadata document and its column name', async () => {
    const source = await open(
      'json.ttl',
      JSON_ROWS(`[
        { "time": "2024-05-12T08:00:00Z", "value": "4810.5" },
        { "time": "2024-05-12T08:15:00Z", "value": "4722.4" },
        { "time": "2024-05-12T08:30:00Z", "value": "4751.9" },
        { "time": "2024-05-12T09:15:00Z", "value": "4719.3" },
        { "time": "2024-05-12T09:45:00Z", "value": "4783.6" }
      ]`),
    );
    const property = `${server.url}/json.ttl#value`;
    expect(source.resolveField('json-value-field').property).toBe(property);
    expect(values(await all(source.read()), 'json-value-field')).toEqual(['4810.5', '4722.4', '4751.9', '4719.3', '4783.6']);
    const [head, first] = await ntriples(await all(source.expand()));
    expect(head).not.toContain(`<${TSS}points>`);
    expect(head).toContain(`<${EX}json-value-field> <${TSS}property> <${property}>`);
    expect(head).toContain(`<${property}> <http://www.w3.org/2000/01/rdf-schema#subPropertyOf> <${TSS}value>`);
    expect(first).toContain(`<${property}> "4810.5"^^<http://www.w3.org/2001/XMLSchema#double>`);
    expect((await source.validate()).results).toEqual([]);
  });

  it('JSON rows where a missing key and null are empty values', async () => {
    const source = await open(
      'json-empty.ttl',
      JSON_ROWS(`[
        { "time": "2024-05-12T08:00:00Z", "value": "4810.5" },
        { "time": "2024-05-12T08:30:00Z", "value": 4751.9 },
        { "time": "2024-05-12T09:15:00Z", "value": null },
        { "time": "2024-05-12T09:45:00Z" }
      ]`),
    );
    expect(values(await all(source.read()), 'json-value-field')).toEqual(['4810.5', '4751.9', undefined, undefined]);
  });

  it('the CSV example and its expansion, with the data file as base of the default property', async () => {
    const source = await open('csv.ttl', CSV_EXAMPLE);
    const rows = await all(source.read());
    expect(rows.map((r) => r.time)).toEqual(['2024-05-01T00:00:00Z', '2024-05-01T00:15:00Z', '2024-05-01T00:30:00Z']);
    expect(values(rows, 'csv-value-field')).toEqual(['12.5', undefined, '12.7']);
    const property = `${server.url}/data.csv#value`;
    const [head, first, second] = await ntriples(await all(source.expand()));
    expect(head).toContain(`<${EX}csv-time-field> <${TSS}property> <${TSS}time>`);
    expect(head).toContain(`<${EX}csv-value-field> <${TSS}property> <${property}>`);
    expect(head).toContain(`<${property}> <http://www.w3.org/2000/01/rdf-schema#subPropertyOf> <${TSS}value>`);
    expect(first).toContain(`<${EX}csv-source> <${TSS}hasPoint>`);
    expect(first).toContain(`<${TSS}field> <${EX}csv-value-field>`);
    expect(first).toContain(`<${property}> "12.5"^^<http://www.w3.org/2001/XMLSchema#double>`);
    // the empty cell is no point
    expect(second).toContain('"12.7"');
    expect((await source.validate()).results).toEqual([]);
  });

  it('the point IRIs of tss:aboutUrl', async () => {
    const source = await open('about.ttl', CSV_EXAMPLE.replace('tss:columnName "value" ;', 'tss:columnName "value" ;\n    tss:aboutUrl "https://example.org/obs/value/{time}" ;'));
    const [, first] = await ntriples(await all(source.expand()));
    expect(first).toContain(`<${EX}csv-source> <${TSS}hasPoint> <https://example.org/obs/value/2024-05-01T00%3A00%3A00Z>`);
    expect((await source.validate()).results).toEqual([]);

    const clash = await open('about-clash.ttl', CSV_EXAMPLE.replace('tss:columnName "value" ;', 'tss:columnName "value" ;\n    tss:aboutUrl "obs/value" ;'));
    const report = await clash.validate();
    expect(report.results.map((r) => r.rule)).toContain('about-url');
  });

  it('finds the columns by index when there is no header line', async () => {
    const source = await open(
      'headerless.ttl',
      external(
        'CSVSource',
        `    tss:dataFile <data-no-header.csv> ; tss:header false ; tss:timeField ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:MetaField ; tss:columnName "time" ; tss:columnIndex 0 ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:ValueField ; tss:columnName "value" ; tss:columnIndex 1 ; tss:datatype xsd:double .`,
      ),
    );
    expect(values(await all(source.read()), 'v')).toEqual(['12.5', '12.7']);
  });

  it('computes the times of a time grid; steps without a row have no row', async () => {
    const source = await open(
      'grid.ttl',
      external(
        'CSVSource',
        `    tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; tss:until "2024-05-13T00:00:00Z"^^xsd:dateTimeStamp ;
    tss:dataFile <grid.csv> ; tss:timeBase "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; tss:timeStep "PT15M"^^xsd:duration ;
    tss:timeField ex:t ; tss:stepField ex:s ; tss:key ex:t ; tss:hasField ex:t, ex:s, ex:v .
ex:t a tss:MetaField ; tss:datatype xsd:dateTimeStamp .
ex:s a tss:MetaField ; tss:columnName "step" ; tss:datatype xsd:integer .
ex:v a tss:ValueField ; tss:columnName "value" ; tss:datatype xsd:double .`,
      ),
    );
    const rows = await all(source.read());
    expect(rows.map((r) => r.time)).toEqual([
      '2024-05-12T08:00:00Z',
      '2024-05-12T08:15:00Z',
      '2024-05-12T08:30:00Z',
      '2024-05-12T09:15:00Z',
      '2024-05-12T09:45:00Z',
    ]);
    expect([...rows[0].fields()].map(([id]) => id)).toEqual(['https://example.org/ex#v']);
    // the step is a meta field: it is not stated on the points
    const [, first] = await ntriples(await all(source.expand()));
    expect(first).not.toContain('#step');
    expect((await source.validate()).results).toEqual([]);
  });

  it('decodes values stated as differences from a baseline, exactly', async () => {
    const source = await open(
      'delta.ttl',
      external(
        'CSVSource',
        `    tss:dataFile <delta.csv> ; tss:timeField ex:t ; tss:key ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:MetaField ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:ValueField ; tss:columnName "value" ; tss:datatype xsd:double ;
    tss:valueEncoding tss:DeltaFromBaseline ; tss:baseline "4750"^^xsd:double .`,
      ),
    );
    expect(values(await all(source.read()), 'v')).toEqual(['4810.5', '4722.4']);
    // the points state the decoded values
    const [, first] = await ntriples(await all(source.expand()));
    expect(first).toContain('"4810.5"^^<http://www.w3.org/2001/XMLSchema#double>');
  });

  it('only reads the rows in the time window of an external source', async () => {
    const source = await open(
      'window.ttl',
      external(
        'CSVSource',
        `    tss:from "2024-05-01T00:10:00Z"^^xsd:dateTimeStamp ; tss:until "2024-05-01T00:30:00Z"^^xsd:dateTimeStamp ;
    tss:dataFile <data.csv> ; tss:delimiter ";" ; tss:timeField ex:t ; tss:hasField ex:t, ex:v .
ex:t a tss:MetaField ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:ValueField ; tss:columnName "value" ; tss:datatype xsd:double .`,
      ),
    );
    expect((await all(source.read())).map((r) => r.time)).toEqual(['2024-05-01T00:15:00Z']);
  });

  it('refuses a local data file in a fetched document unless localFiles is set', async () => {
    const turtle = external(
      'CSVSource',
      `    tss:dataFile <file:///etc/hostname> ; tss:timeField ex:t ; tss:hasField ex:t .
ex:t a tss:MetaField ; tss:columnName "time" ; tss:datatype xsd:dateTimeStamp .`,
    );
    await writeFile(join(dir, 'local.ttl'), turtle);
    const source = await Source.fetch(`${server.url}/local.ttl`);
    await expect(source.read().next()).rejects.toThrow(/local file/);
  });

  it('expands the values as published: a converted unit is refused', async () => {
    const source = await open('converted.ttl', MULTI_SENSOR);
    await expect(all(toRDFMessages(source.read({ unit: 'http://qudt.org/vocab/unit/DEG_F', fields: ['temperature-field'] })))).rejects.toThrow(/unit: 'source'/);
  });

  it('points out the class names of RDF Time Series Snippets', async () => {
    const ds = await parseRdf(`${PREFIXES}\nex:s a tss:EmbeddedRDFSnippet ; tss:timeField ex:t ; tss:hasField ex:t .`);
    await expect(Source.open(ds)).rejects.toThrow(/tss:EmbeddedRDFSnippet|EmbeddedRDFSnippet is an RDF Time Series Snippets class/);
  });

  it('reports what does not conform', async () => {
    const source = await Source.open(
      await parseRdf(
        `${PREFIXES}
ex:s a tss:EmbeddedRDFSource ; tss:mutable true ; tss:committedUntil "2024-05-12T09:00:00Z"^^xsd:dateTimeStamp ; tss:timeField ex:t ; tss:hasField ex:t, ex:v, ex:w, ex:q ; tss:from "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ;
  tss:until "2024-05-12T09:00:00Z"^^xsd:dateTimeStamp ; tss:dataFile <x.csv> ; tss:snippetDescription [] .
ex:t a tss:ValueField ; tss:datatype xsd:dateTimeStamp .
ex:v a tss:ValueField ; tss:property ex:v-value ; tss:datatype xsd:double .
ex:w a tss:Field ; tss:property ex:w-value ; tss:datatype xsd:double ; tss:aboutUrl "w/{t}" .
ex:q a tss:MetaField ; tss:property tss:value ; tss:datatype xsd:string ; tss:sensor ex:sensor ; tss:describesField ex:nothing .
ex:s tss:hasPoint [ tss:time "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; ex:v-value "twelve"^^xsd:double ] .
ex:s tss:hasPoint [ tss:time "2024-05-12T08:00:00Z"^^xsd:dateTimeStamp ; ex:v-value "12"^^xsd:double ] .
ex:s tss:hasPoint [ tss:time "2024-05-12T08:10:00Z"^^xsd:dateTimeStamp ; ex:v-value "1"^^xsd:double ; ex:w-value "2"^^xsd:double ] .
ex:s tss:hasPoint [ tss:time "2024-05-12T10:00:00Z"^^xsd:dateTimeStamp ; ex:v-value "1"^^xsd:integer ] .
ex:s tss:hasPoint [ tss:time "2024-05-12T08:20:00Z"^^xsd:dateTimeStamp ; ex:v "3"^^xsd:double ] .`,
      ),
    );
    const report = await source.validate();
    expect(report.conforms).toBe(false);
    const rules = report.results.map((r) => r.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        'removed-term',
        'not-allowed',
        'lexical-form',
        'window',
        'value-datatype',
        'field-kind',
        'meta-field',
        'property',
        'describes-field',
        'about-url',
        'point-value',
        'unique-point',
        'field-as-property',
      ]),
    );
  });
});
