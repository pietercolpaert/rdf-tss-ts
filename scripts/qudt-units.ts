/**
 * Writes playground/qudt-units.json: the units of QUDT that eyemind can convert, with their
 * symbol, label, quantity kinds and whether they are SI units. The playground offers a reading
 * in the units of its quantity kind: W/m² as kW/m², W/cm² or BTU/(ft²·h), not every unit of the
 * same dimension (such as W/(m²·sr), a radiance). Run it again when eyemind updates its catalog
 * of QUDT: `npm run qudt-units`.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseRdf } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUDT = 'http://qudt.org/schema/qudt/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const UNIT = 'http://qudt.org/vocab/unit/';
const QK = 'http://qudt.org/vocab/quantitykind/';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SI = 'http://qudt.org/vocab/sou/SI';

// the catalog of eyemind: the units it converts, from the same release of QUDT
const eyemind = dirname(createRequire(import.meta.url).resolve('eyemind/package.json'));
const { UNITS, QUDT_RELEASE } = (await import(pathToFileURL(join(eyemind, 'src', 'qudt-catalog.js')).href)) as { UNITS: string; QUDT_RELEASE: string };
// a unit with an offset, such as °C, is no unit for a difference of values
const catalog = new Map(UNITS.split('\n').filter(Boolean).map((line) => line.split('\t')).map((cells) => [cells[0], { multiplier: Number(cells[1]), offset: Number(cells[2]) !== 0 }]));

const url = `https://raw.githubusercontent.com/qudt/qudt-public-repo/${QUDT_RELEASE}/src/main/rdf/vocab/unit/VOCAB_QUDT-UNITS-ALL.ttl`;
const response = await fetch(url);
if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
const ds = await parseRdf(await response.text(), { contentType: 'text/turtle' });

const objects = (subject: string, predicate: string) => ds.getObjects(subject, predicate, null);
const english = (subject: string, predicate: string) => {
  const all = objects(subject, predicate);
  return (all.find((o) => (o as { language?: string }).language === 'en') ?? all.find((o) => !(o as { language?: string }).language) ?? all[0])?.value;
};

/**
 * By unit: [symbol, label, quantity kinds, an SI unit (1) or not (0), an offset (1) or not (0),
 * how common it is, its multiplier to the SI unit of its dimension]. QUDT does not say which units
 * are common; a common unit has more codes in other systems: UCUM, UN/ECE, IEC 61360, Wikidata.
 */
const units: Record<string, [string, string, string[], 0 | 1, 0 | 1, number, number]> = {};
const CODES = ['ucumCode', 'uneceCommonCode', 'iec61360Code', 'wikidataMatch'].map((p) => QUDT + p);
for (const subject of ds.getSubjects(`${RDF_TYPE}`, `${QUDT}Unit`, null)) {
  const iri = subject.value;
  if (!iri.startsWith(UNIT)) continue;
  const name = iri.slice(UNIT.length);
  const converted = catalog.get(name);
  if (!converted) continue;
  if (objects(iri, `${QUDT}deprecated`).some((o) => o.value === 'true')) continue;
  // QUDT 3 states the quantity kinds of a unit with qudt:unitForQuantityKind, earlier ones with qudt:hasQuantityKind
  const kinds = [...objects(iri, `${QUDT}unitForQuantityKind`), ...objects(iri, `${QUDT}hasQuantityKind`)]
    .map((o) => o.value)
    .filter((k) => k.startsWith(QK))
    .map((k) => k.slice(QK.length))
    .filter((k, i, all) => all.indexOf(k) === i)
    .sort();
  if (kinds.length === 0) continue;
  const si = objects(iri, `${QUDT}applicableSystem`).some((o) => o.value === SI) ? 1 : 0;
  const common = CODES.filter((p) => objects(iri, p).length > 0).length;
  units[name] = [english(iri, `${QUDT}symbol`) ?? name, english(iri, `${RDFS}label`) ?? name, kinds, si, converted.offset ? 1 : 0, common, converted.multiplier];
}

const out = join(root, 'playground', 'qudt-units.json');
await writeFile(out, JSON.stringify({ release: QUDT_RELEASE, source: url, units }) + '\n');
console.log(`wrote ${Object.keys(units).length} units of QUDT ${QUDT_RELEASE} to ${out}`);
