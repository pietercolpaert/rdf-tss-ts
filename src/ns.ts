export const TSS = 'https://w3id.org/tss#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const SOSA = 'http://www.w3.org/ns/sosa/';
export const SAREF = 'https://saref.etsi.org/core/';
export const QUDT = 'http://qudt.org/schema/qudt/';
export const UNIT = 'http://qudt.org/vocab/unit/';
export const DCTERMS = 'http://purl.org/dc/terms/';

export const tss = (name: string) => TSS + name;
export const xsd = (name: string) => XSD + name;

export const SOURCE_CLASSES = {
  EmbeddedRDF: tss('EmbeddedRDFSource'),
  EmbeddedJSON: tss('EmbeddedJSONSource'),
  CSV: tss('CSVSource'),
  Arrow: tss('ArrowSource'),
  Parquet: tss('ParquetSource'),
} as const;

/** The class names of earlier drafts (RDF Time Series Snippets), to point out the rename. */
export const LEGACY_SOURCE_CLASSES: Record<string, string> = Object.fromEntries(
  Object.values(SOURCE_CLASSES).map((iri) => [iri.replace(/Source$/, 'Snippet'), iri]),
);

export type SourceKind = keyof typeof SOURCE_CLASSES;

export const KIND_BY_CLASS: Record<string, SourceKind> = Object.fromEntries(
  Object.entries(SOURCE_CLASSES).map(([kind, iri]) => [iri, kind as SourceKind]),
);

export const EXTERNAL_KINDS: SourceKind[] = ['CSV', 'Arrow', 'Parquet'];
export const isExternalKind = (kind: SourceKind) => EXTERNAL_KINDS.includes(kind);

export const VALUE_FIELD = tss('ValueField');
/** The RDF Message Stream Profile of RDF Time Series Sources: `<stream> dcterms:conformsTo tss:MessageStreamProfile`. */
export const MESSAGE_STREAM_PROFILE = tss('MessageStreamProfile');
export const META_FIELD = tss('MetaField');
