import { describe, expect, it } from 'vitest';
import { Source, parseRdf, type RDFMessage } from '../src/index.js';

// The alignment with SOSA and SAREF is derived by a reasoner (eyemind, OWL 2 RL) from the TSS
// vocabulary of the specification and the description of the source: the library writes none of it.

const SOURCE = `
@prefix tss: <https://w3id.org/tss#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix quantitykind: <http://qudt.org/vocab/quantitykind/> .
@prefix ex: <https://example.org/ex#> .
ex:s a tss:EmbeddedRDFSource ; tss:immutable true ; tss:timeField ex:t ; tss:hasField ex:t, ex:temp, ex:hum, ex:status .
ex:t a tss:ContextField ; tss:datatype xsd:dateTime .
ex:temp a tss:ValueField ; tss:datatype xsd:double ; tss:observedProperty quantitykind:Temperature ; tss:unit unit:DEG_C ;
    tss:sensor ex:thermometer ; tss:featureOfInterest ex:air .
ex:hum a tss:ValueField ; tss:datatype xsd:double ; tss:unit unit:PERCENT_RH ; tss:sensor ex:hygrometer .
ex:status a tss:ContextField ; tss:property ex:status-value ; tss:datatype xsd:string ; tss:describesField ex:temp .
ex:s tss:hasPoint
    [ tss:field ex:temp ; tss:time "2024-05-12T08:00:00Z"^^xsd:dateTime ; tss:value "18.2"^^xsd:double ; ex:status-value "ok" ] ,
    [ tss:field ex:hum ; tss:time "2024-05-12T08:00:00Z"^^xsd:dateTime ; tss:value "61.0"^^xsd:double ] .
ex:s tss:hasPoint [ tss:field ex:temp ; tss:time "2024-05-12T08:10:00Z"^^xsd:dateTime ; tss:value "18.4"^^xsd:double ] .
`;

const S = 'http://www.w3.org/ns/sosa/';
const SAREF = 'https://saref.etsi.org/core/';
const EX = 'https://example.org/ex#';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const short = (iri: string) => iri.replace(S, 'sosa:').replace(SAREF, 'saref:').replace(EX, 'ex:').replace('http://qudt.org/schema/qudt/', 'qudt:').replace('http://qudt.org/vocab/unit/', 'unit:').replace('http://qudt.org/vocab/quantitykind/', 'qk:').replace(TYPE, 'a');

/** What was derived for each point of a row message, by the value field of the point. */
function derived(message: RDFMessage): Record<string, string[]> {
  const field = new Map(message.quads.filter((q) => q.predicate.value === 'https://w3id.org/tss#field').map((q) => [q.subject.value, short(q.object.value)]));
  const out: Record<string, string[]> = {};
  for (const q of message.quads) {
    if (q.predicate.value.startsWith('https://w3id.org/tss#') || q.predicate.value === `${EX}status-value`) continue;
    const key = field.get(q.subject.value)!;
    (out[key] ??= []).push(`${short(q.predicate.value)} ${short(q.object.value)}`);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

describe('the alignment, derived by a reasoner', () => {
  it('SOSA: every point is an observation, with what its own field observes', async () => {
    const source = await Source.open(await parseRdf(SOURCE));
    const messages: RDFMessage[] = [];
    for await (const m of source.expand({ align: 'sosa', metadata: false })) messages.push(m);
    expect(messages).toHaveLength(2);
    expect(derived(messages[0])).toEqual({
      'ex:temp': [
        'a sosa:Observation',
        'qudt:hasUnit unit:DEG_C',
        'sosa:hasFeatureOfInterest ex:air',
        'sosa:hasSimpleResult 18.2',
        'sosa:madeBySensor ex:thermometer',
        'sosa:observedProperty qk:Temperature',
        'sosa:resultTime 2024-05-12T08:00:00Z',
      ],
      'ex:hum': ['a sosa:Observation', 'qudt:hasUnit unit:PERCENT_RH', 'sosa:hasSimpleResult 61.0', 'sosa:madeBySensor ex:hygrometer', 'sosa:resultTime 2024-05-12T08:00:00Z'],
    });
    expect(derived(messages[1])['ex:temp']).toContain('sosa:hasSimpleResult 18.4');
  });

  it('SAREF: every point is a measurement', async () => {
    const source = await Source.open(await parseRdf(SOURCE));
    const messages: RDFMessage[] = [];
    for await (const m of source.expand({ align: 'saref', metadata: false })) messages.push(m);
    expect(derived(messages[0])['ex:temp']).toEqual([
      'a saref:Measurement',
      'saref:hasTimestamp 2024-05-12T08:00:00Z',
      'saref:hasValue 18.2',
      'saref:isMeasuredIn unit:DEG_C',
      'saref:isMeasurementOf ex:air',
      'saref:measurementMadeBy ex:thermometer',
      'saref:relatesToProperty qk:Temperature',
    ]);
  });

  it('without align, nothing is derived', async () => {
    const source = await Source.open(await parseRdf(SOURCE));
    const messages: RDFMessage[] = [];
    for await (const m of source.expand({ metadata: false })) messages.push(m);
    expect(derived(messages[0])).toEqual({});
  });
});
