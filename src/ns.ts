export const TSS = 'https://w3id.org/tss#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const SOSA = 'http://www.w3.org/ns/sosa/';
export const QUDT = 'http://qudt.org/schema/qudt/';
export const UNIT = 'http://qudt.org/vocab/unit/';
export const DCTERMS = 'http://purl.org/dc/terms/';

export const tss = (name: string) => TSS + name;
export const xsd = (name: string) => XSD + name;

export const SNIPPET_CLASSES = {
  EmbeddedRDF: tss('EmbeddedRDFSnippet'),
  EmbeddedJSON: tss('EmbeddedJSONSnippet'),
  CSV: tss('CSVSnippet'),
  Arrow: tss('ArrowSnippet'),
  Parquet: tss('ParquetSnippet'),
} as const;

export type SnippetKind = keyof typeof SNIPPET_CLASSES;

export const KIND_BY_CLASS: Record<string, SnippetKind> = Object.fromEntries(
  Object.entries(SNIPPET_CLASSES).map(([kind, iri]) => [iri, kind as SnippetKind]),
);

export const EXTERNAL_KINDS: SnippetKind[] = ['CSV', 'Arrow', 'Parquet'];
export const isExternalKind = (kind: SnippetKind) => EXTERNAL_KINDS.includes(kind);
