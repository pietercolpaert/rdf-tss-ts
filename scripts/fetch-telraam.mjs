#!/usr/bin/env node
/**
 * Takes a real sample from the Telraam LDES (https://ldes.telraam-api.net/measurements):
 * every hour of one day, for the first few locations that have all eight series (bike,
 * car, heavy, pedestrian, left and right) in every hour. The members are kept exactly as
 * the LDES publishes them, and written to examples/telraam/members.ttl.
 *
 *   node scripts/fetch-telraam.mjs [YYYY-MM-DD] [locations]
 *
 * The data is published as open data (Vlaamse Open data Service, access right: public).
 */
import { writeFile } from 'node:fs/promises';
import { Parser, Writer } from 'n3';

const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const wanted = Number(process.argv[3] ?? 3);
const [year, month, date] = day.split('-').map(Number);

const VERKEER = 'https://data.vlaanderen.be/ns/verkeersmetingen#';
const PROV = 'http://www.w3.org/ns/prov#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const IMPL = 'https://implementatie.data.vlaanderen.be/ns/vsds-verkeersmetingen#';

const url = (hour) =>
  `https://ldes.telraam-api.net/measurements/by-time?year=${year}&month=${String(month).padStart(2, '0')}&day=${String(date).padStart(2, '0')}&hour=${String(hour).padStart(2, '0')}&pageNumber=1`;

/** Members (nodes of type impl:Verkeerstelling) of one page, with all their quads. */
async function members(hour) {
  const response = await fetch(url(hour), { headers: { Accept: 'text/turtle' } });
  if (!response.ok) throw new Error(`hour ${hour}: HTTP ${response.status}`);
  const parser = new Parser({ baseIRI: response.url });
  const quads = parser.parse(await response.text());
  const bySubject = new Map();
  for (const q of quads) {
    const key = q.subject.termType + q.subject.value;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(q);
  }
  const out = [];
  for (const [, own] of bySubject) {
    if (!own.some((q) => q.predicate.value === RDF_TYPE && q.object.value === IMPL + 'Verkeerstelling')) continue;
    const location = own.find((q) => q.predicate.value === VERKEER + 'geobserveerdObject').object.value;
    const series = own.find((q) => q.predicate.value === 'http://purl.org/dc/terms/isVersionOf').object.value.split('#')[1];
    out.push({ subject: own[0].subject, location, series, quads: collect(bySubject, own) });
  }
  return { out, prefixes: parser._prefixes ?? {} };
}

/** The quads of a member, with the blank nodes it points to. */
function collect(bySubject, own) {
  const quads = [...own];
  for (const q of own) {
    if (q.object.termType === 'BlankNode') quads.push(...collect(bySubject, bySubject.get('BlankNode' + q.object.value) ?? []));
  }
  return quads;
}

const perHour = [];
for (let hour = 0; hour < 24; hour++) {
  const { out } = await members(hour);
  perHour.push(out);
  console.log(`hour ${hour}: ${out.length} members on page 1`);
}

// locations with all eight series in every hour
const complete = (location) => perHour.every((hourMembers) => new Set(hourMembers.filter((m) => m.location === location).map((m) => m.series)).size === 8);
const locations = [...new Set(perHour[0].map((m) => m.location))].filter(complete).sort().slice(0, wanted);
if (locations.length < wanted) throw new Error(`only ${locations.length} locations have all series in every hour`);
console.log('locations:', locations.join(', '));

const writer = new Writer({
  prefixes: {
    telraam: 'https://telraam.net/en/location/',
    verkeer: VERKEER,
    impl: IMPL,
    prov: PROV,
    sosa: 'http://www.w3.org/ns/sosa/',
    terms: 'http://purl.org/dc/terms/',
    time: 'http://www.w3.org/2006/time#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    'iso19156-ob': 'http://def.isotc211.org/iso19156/2011/Observation#',
    'cl-vrt': 'https://data.vlaanderen.be/doc/concept/VkmVoertuigType/',
    'cl-vkt': 'https://data.vlaanderen.be/doc/concept/VkmVerkeersKenmerkType/',
    'cl-mit': 'https://data.vlaanderen.be/doc/concept/VkmMeetInstrumentType/',
    'cl-trt': 'https://inspire.ec.europa.eu/codelist/LinkDirectionValue/',
  },
});
let count = 0;
for (const hourMembers of perHour) {
  for (const member of hourMembers) {
    if (!locations.includes(member.location)) continue;
    count++;
    for (const q of member.quads) writer.addQuad(q);
  }
}
const ttl = await new Promise((resolve, reject) => writer.end((e, r) => (e ? reject(e) : resolve(r))));
await writeFile(new URL('../examples/telraam/members.ttl', import.meta.url), `# ${count} members of https://ldes.telraam-api.net/measurements, ${day}, locations ${locations.join(', ')}\n${ttl}`);
console.log(`wrote ${count} members (${(ttl.length / 1024).toFixed(0)} KB)`);
