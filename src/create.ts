import { Store } from 'n3';
import { RDF, RDFS, SNIPPET_CLASSES, isExternalKind, tss, xsd } from './ns.js';
import { literal, namedNode, quad } from './rdf.js';
import type { Quad, Term } from './rdf.js';
import { localNameOf } from './metadata.js';
import type { CreateOptions } from './types.js';

const lit = (value: string, datatype: string) => literal(value, namedNode(datatype));

/** The RDF description of a new snippet; `dataFileRef` is how the metadata refers to the data file. */
export function buildStore(options: CreateOptions, dataFileRef?: string): Store {
  const store = new Store();
  const add = (s: Term, p: string, o: Term) => store.addQuad(quad(s as never, namedNode(p), o as never));

  const snippet = namedNode(options.id);
  const external = isExternalKind(options.kind);
  const needsColumnNames = options.kind !== 'EmbeddedRDF';

  add(snippet, RDF + 'type', namedNode(SNIPPET_CLASSES[options.kind]));
  if (options.label) add(snippet, RDFS + 'label', literal(options.label));
  // a growing snippet does not state tss:immutable: it is added when the snippet is ended
  if (options.immutable) add(snippet, tss('immutable'), lit('true', xsd('boolean')));
  if (options.from) add(snippet, tss('from'), lit(options.from, xsd('dateTimeStamp')));
  if (options.until) add(snippet, tss('until'), lit(options.until, xsd('dateTimeStamp')));
  add(snippet, tss('timeField'), namedNode(options.timeField.id));
  if (external) {
    if (!dataFileRef) throw new Error(`a ${options.kind} snippet needs a dataFile`);
    add(snippet, tss('dataFile'), namedNode(dataFileRef));
  }
  if (options.kind === 'CSV') {
    if (options.csv?.delimiter !== undefined) add(snippet, tss('delimiter'), literal(options.csv.delimiter));
    if (options.csv?.encoding !== undefined) add(snippet, tss('encoding'), literal(options.csv.encoding));
    if (options.csv?.header !== undefined) add(snippet, tss('header'), lit(String(options.csv.header), xsd('boolean')));
  }
  if (options.kind === 'EmbeddedJSON') add(snippet, tss('points'), lit('[]', RDF + 'JSON'));

  const time = namedNode(options.timeField.id);
  add(snippet, tss('hasField'), time);
  add(time, RDF + 'type', namedNode(tss('Field')));
  add(time, tss('datatype'), namedNode(xsd('dateTimeStamp')));
  if (needsColumnNames || options.timeField.columnName !== undefined) {
    add(time, tss('columnName'), literal(options.timeField.columnName ?? localNameOf(options.timeField.id)));
  }
  if (options.timeField.columnIndex !== undefined) add(time, tss('columnIndex'), lit(String(options.timeField.columnIndex), xsd('integer')));

  for (const f of options.fields) {
    const field = namedNode(f.id);
    add(snippet, tss('hasField'), field);
    add(field, RDF + 'type', namedNode(tss('Field')));
    if (f.label) add(field, RDFS + 'label', literal(f.label));
    add(field, tss('datatype'), namedNode(f.datatype ?? xsd('decimal')));
    if (needsColumnNames || f.columnName !== undefined) add(field, tss('columnName'), literal(f.columnName ?? localNameOf(f.id)));
    if (f.columnIndex !== undefined) add(field, tss('columnIndex'), lit(String(f.columnIndex), xsd('integer')));
    if (f.observedProperty) add(field, tss('observedProperty'), namedNode(f.observedProperty));
    if (f.unit) add(field, tss('unit'), namedNode(f.unit));
    if (f.sensor) add(field, tss('sensor'), namedNode(f.sensor));
    if (f.featureOfInterest) add(field, tss('featureOfInterest'), namedNode(f.featureOfInterest));
    if (f.describesField) add(field, tss('describesField'), namedNode(f.describesField));
    if (f.minimum !== undefined) add(field, tss('minimum'), lit(String(f.minimum), f.datatype ?? xsd('decimal')));
    if (f.maximum !== undefined) add(field, tss('maximum'), lit(String(f.maximum), f.datatype ?? xsd('decimal')));
  }
  return store;
}

export type { Quad };
