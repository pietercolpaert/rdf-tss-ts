/**
 * Turns members of the Telraam LDES into RDF-TSS sources, and measures how much smaller
 * they are.
 *
 * Every LDES member is one hourly traffic count of one series (e.g. `bike-lft`) at one
 * location, described with ~25 triples. The counts of one location share their time, so
 * they fit one table: one source per location, one column per series, one row per hour.
 */
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataFactory, Parser, Writer } from 'n3';
import type { Quad } from '@rdfjs/types';
import { Source, type CreateField, type SourceKind } from '../src/index.js';

const { namedNode, blankNode, quad } = DataFactory;

const VERKEER = 'https://data.vlaanderen.be/ns/verkeersmetingen#';
const IMPL = 'https://implementatie.data.vlaanderen.be/ns/vsds-verkeersmetingen#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const TERMS = 'http://purl.org/dc/terms/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const TSS = 'https://w3id.org/tss#';
const AANTAL = 'https://data.vlaanderen.be/doc/concept/VkmVerkeersKenmerkType/aantal';
const SENSOR_TYPE = 'https://data.vlaanderen.be/doc/concept/VkmMeetInstrumentType/telraam';

export const PREFIXES = {
  telraam: 'https://telraam.net/en/location/',
  verkeer: VERKEER,
  impl: IMPL,
  prov: 'http://www.w3.org/ns/prov#',
  sosa: 'http://www.w3.org/ns/sosa/',
  terms: TERMS,
  time: 'http://www.w3.org/2006/time#',
  xsd: XSD,
  'iso19156-ob': 'http://def.isotc211.org/iso19156/2011/Observation#',
  'cl-vrt': 'https://data.vlaanderen.be/doc/concept/VkmVoertuigType/',
  'cl-vkt': 'https://data.vlaanderen.be/doc/concept/VkmVerkeersKenmerkType/',
  'cl-mit': 'https://data.vlaanderen.be/doc/concept/VkmMeetInstrumentType/',
  'cl-trt': 'https://inspire.ec.europa.eu/codelist/LinkDirectionValue/',
};

export interface Member {
  /** IRI of the location, e.g. `https://telraam.net/en/location/27387`. */
  location: string;
  /** IRI of the series (the member is a version of it), e.g. `…/27387#bike-lft`. */
  series: string;
  /** `prov:generatedAtTime`, as published. */
  time: string;
  /** `impl:Verkeerstelling.tellingresultaat`, as published. */
  value: string;
  vehicleType: string;
  direction: string;
  /** All quads of the member, with its blank nodes. */
  quads: Quad[];
}

/** Read the members of an LDES page (or of the sample) in Turtle. */
export function parseMembers(turtle: string): Member[] {
  const quads = new Parser().parse(turtle);
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = q.subject.termType + q.subject.value;
    bySubject.set(key, [...(bySubject.get(key) ?? []), q]);
  }
  const collect = (own: Quad[]): Quad[] => {
    const all = [...own];
    for (const q of own) if (q.object.termType === 'BlankNode') all.push(...collect(bySubject.get('BlankNode' + q.object.value) ?? []));
    return all;
  };
  const one = (own: Quad[], predicate: string) => own.find((q) => q.predicate.value === predicate)?.object;
  const members: Member[] = [];
  for (const own of bySubject.values()) {
    if (!own.some((q) => q.predicate.value === RDF_TYPE && q.object.value === IMPL + 'Verkeerstelling')) continue;
    const kenmerk = bySubject.get('BlankNode' + one(own, IMPL + 'Verkeerstelling.geobserveerdKenmerk')!.value)!;
    members.push({
      location: one(own, VERKEER + 'geobserveerdObject')!.value,
      series: one(own, TERMS + 'isVersionOf')!.value,
      time: one(own, 'http://www.w3.org/ns/prov#generatedAtTime')!.value,
      value: one(own, IMPL + 'Verkeerstelling.tellingresultaat')!.value,
      vehicleType: one(kenmerk, VERKEER + 'voertuigType')!.value,
      direction: one(kenmerk, IMPL + 'Verkeerstellingkenmerk.rijrichting')!.value,
      quads: collect(own),
    });
  }
  return members;
}

export async function readMembers(path: string): Promise<Member[]> {
  return parseMembers(await readFile(path, 'utf8'));
}

const bytes = (text: string | Uint8Array) => (typeof text === 'string' ? Buffer.byteLength(text) : text.length);
const gzip = (data: string | Uint8Array) => gzipSync(data).length;

async function turtleOf(quads: Quad[]): Promise<string> {
  const writer = new Writer({ prefixes: PREFIXES });
  for (const q of quads) writer.addQuad(q);
  return new Promise((resolve, reject) => writer.end((e, r) => (e ? reject(e) : resolve(r as string))));
}

/** Size of a set of LDES members as Turtle, and gzipped. */
export async function ldesSize(members: Member[]): Promise<{ members: number; bytes: number; gzip: number }> {
  const turtle = await turtleOf(members.flatMap((m) => m.quads));
  return { members: members.length, bytes: bytes(turtle), gzip: gzip(turtle) };
}

export interface Conversion {
  location: string;
  id: string;
  source: string;
  metadataFile: string;
  dataFile: string;
  kind: SourceKind;
  readings: number;
  series: string[];
}

/** One source with the counts of one location: a column per series, a row per hour. */
export async function convertLocation(
  members: Member[],
  location: string,
  options: { dir: string; kind: 'CSV' | 'Parquet' | 'Arrow'; name: string; day: string },
): Promise<Conversion> {
  const own = members.filter((m) => m.location === location);
  const id = location.split('/').pop()!;
  const extension = { CSV: 'csv', Parquet: 'parquet', Arrow: 'arrows' }[options.kind];

  const series = new Map<string, Member>();
  for (const m of own) if (!series.has(m.series)) series.set(m.series, m);
  const names = [...series.keys()].sort();
  const fields: CreateField[] = names.map((iri) => ({
    id: iri,
    label: iri.split('#')[1].replace('-lft', ' (left)').replace('-rgt', ' (right)').replace(/^./, (c) => c.toUpperCase()),
    datatype: `${XSD}double`,
    observedProperty: AANTAL,
    featureOfInterest: location,
    sensor: `${location}#sensor`,
  }));

  const times = [...new Set(own.map((m) => m.time))].sort();
  const source = await Source.create({
    id: `${location}#source-${options.day}`,
    kind: options.kind,
    label: `Traffic counts at Telraam location ${id}, ${options.day}`,
    dataFile: join(options.dir, `${options.name}.${extension}`),
    file: join(options.dir, `${options.name}.ttl`),
    from: times[0],
    until: `${new Date(Date.parse(`${options.day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
    timeField: { id: `${location}#time`, columnName: 'time' },
    fields,
    prefixes: PREFIXES,
  });

  // What the LDES says about each series, kept as a description of the field.
  const description = (iri: string, m: Member): void => {
    const node = blankNode();
    source.dataset.add(quad(namedNode(iri), namedNode(`${TSS}fieldDescription`), node));
    source.dataset.add(quad(node, namedNode(`${VERKEER}voertuigType`), namedNode(m.vehicleType)));
    source.dataset.add(quad(node, namedNode(`${IMPL}Verkeerstellingkenmerk.kenmerktype`), namedNode(AANTAL)));
    source.dataset.add(quad(node, namedNode(`${IMPL}Verkeerstellingkenmerk.rijrichting`), namedNode(m.direction)));
  };
  for (const [iri, m] of series) description(iri, m);
  const sensor = namedNode(`${location}#sensor`);
  source.dataset.add(quad(sensor, namedNode(RDF_TYPE), namedNode('http://www.w3.org/ns/sosa/Sensor')));
  source.dataset.add(quad(sensor, namedNode(`${TERMS}type`), namedNode(SENSOR_TYPE)));

  const byTime = new Map<string, Record<string, string>>();
  for (const m of own) byTime.set(m.time, { ...byTime.get(m.time), [m.series.split('#')[1]]: m.value });
  await source.append(times.map((time) => ({ time, values: byTime.get(time)! })));
  await source.close({ freeze: true });

  return {
    location,
    id,
    source: `${location}#source-${options.day}`,
    metadataFile: join(options.dir, `${options.name}.ttl`),
    dataFile: join(options.dir, `${options.name}.${extension}`),
    kind: options.kind,
    readings: times.length,
    series: names.map((n) => n.split('#')[1]),
  };
}

export interface SizeReport {
  metadata: number;
  data: number;
  total: number;
  gzip: number;
}

export async function sourceSize(conversion: Conversion): Promise<SizeReport> {
  const [metadata, data] = await Promise.all([readFile(conversion.metadataFile), readFile(conversion.dataFile)]);
  return {
    metadata: metadata.length,
    data: data.length,
    total: metadata.length + data.length,
    gzip: gzip(metadata) + gzip(data),
  };
}

export { bytes };
