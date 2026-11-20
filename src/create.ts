import { Store } from 'n3';
import { CONTEXT_FIELD, RDF, RDFS, SOURCE_CLASSES, VALUE_FIELD, isExternalKind, tss, xsd } from './ns.js';
import { literal, namedNode, quad } from './rdf.js';
import type { Quad, Term } from './rdf.js';
import { ValidationError } from './errors.js';
import { localNameOf } from './metadata.js';
import type { CreateOptions } from './types.js';

const lit = (value: string, datatype: string) => literal(value, namedNode(datatype));

/** The RDF description of a new source; `dataFileRef` is how the metadata refers to the data file. */
export function buildStore(options: CreateOptions, dataFileRef?: string): Store {
  const store = new Store();
  const add = (s: Term, p: string, o: Term) => store.addQuad(quad(s as never, namedNode(p), o as never));

  const source = namedNode(options.id);
  const external = isExternalKind(options.kind);
  // An embedded RDF source states its values with the field properties: a field without a
  // tss:property needs a column name to make its default property from.
  // a field of an embedded RDF source only needs a column name to make the default property of a describing field
  const needsColumnName = (describing: boolean, property?: string) => options.kind !== 'EmbeddedRDF' || (describing && property === undefined);

  add(source, RDF + 'type', namedNode(SOURCE_CLASSES[options.kind]));
  if (options.label) add(source, RDFS + 'label', literal(options.label));
  // a growing source does not state tss:immutable: it is added when the source is ended
  if (options.immutable) add(source, tss('immutable'), lit('true', xsd('boolean')));
  if (options.from) add(source, tss('from'), lit(options.from, xsd('dateTime')));
  if (options.until) add(source, tss('until'), lit(options.until, xsd('dateTime')));
  add(source, tss('timeField'), namedNode(options.timeField.id));
  if (external) {
    if (!dataFileRef) throw new Error(`a ${options.kind} source needs a dataFile`);
    add(source, tss('dataFile'), namedNode(dataFileRef));
  }
  if (options.kind === 'CSV') {
    if (options.csv?.delimiter !== undefined) add(source, tss('delimiter'), literal(options.csv.delimiter));
    if (options.csv?.encoding !== undefined) add(source, tss('encoding'), literal(options.csv.encoding));
    if (options.csv?.header !== undefined) add(source, tss('header'), lit(String(options.csv.header), xsd('boolean')));
  }
  if (options.kind === 'EmbeddedJSON') add(source, tss('points'), lit('[]', RDF + 'JSON'));

  const time = namedNode(options.timeField.id);
  add(source, tss('hasField'), time);
  add(time, RDF + 'type', namedNode(CONTEXT_FIELD));
  add(time, tss('datatype'), namedNode(xsd('dateTime')));
  // a point of an embedded RDF source states its time with tss:time: no column name needed
  if (options.kind !== 'EmbeddedRDF' || options.timeField.columnName !== undefined) {
    add(time, tss('columnName'), literal(options.timeField.columnName ?? localNameOf(options.timeField.id)));
  }
  if (options.timeField.columnIndex !== undefined) add(time, tss('columnIndex'), lit(String(options.timeField.columnIndex), xsd('integer')));

  for (const f of options.fields) {
    const field = namedNode(f.id);
    const describes = f.describesField === undefined ? [] : Array.isArray(f.describesField) ? f.describesField : [f.describesField];
    const kind = f.kind ?? (describes.length > 0 ? 'context' : 'value');
    if (f.property && describes.length === 0) {
      throw new ValidationError(`field ${f.id}: only a describing field states tss:property; a point states its reading with tss:value`);
    }
    add(source, tss('hasField'), field);
    add(field, RDF + 'type', namedNode(kind === 'value' ? VALUE_FIELD : CONTEXT_FIELD));
    if (f.label) add(field, RDFS + 'label', literal(f.label));
    add(field, tss('datatype'), namedNode(f.datatype ?? xsd('decimal')));
    if (needsColumnName(describes.length > 0, f.property) || f.columnName !== undefined) add(field, tss('columnName'), literal(f.columnName ?? localNameOf(f.id)));
    if (f.columnIndex !== undefined) add(field, tss('columnIndex'), lit(String(f.columnIndex), xsd('integer')));
    if (f.property) add(field, tss('property'), namedNode(f.property));
    if (f.aboutUrl) add(field, tss('aboutUrl'), literal(f.aboutUrl));
    if (f.observedProperty) add(field, tss('observedProperty'), namedNode(f.observedProperty));
    if (f.unit) add(field, tss('unit'), namedNode(f.unit));
    if (f.sensor) add(field, tss('sensor'), namedNode(f.sensor));
    if (f.featureOfInterest) add(field, tss('featureOfInterest'), namedNode(f.featureOfInterest));
    for (const target of describes) add(field, tss('describesField'), namedNode(target));
    if (f.minimum !== undefined) add(field, tss('minimum'), lit(String(f.minimum), f.datatype ?? xsd('decimal')));
    if (f.maximum !== undefined) add(field, tss('maximum'), lit(String(f.maximum), f.datatype ?? xsd('decimal')));
  }
  return store;
}

export type { Quad };
