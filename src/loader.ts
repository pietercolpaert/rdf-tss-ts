import { Store } from 'n3';
import type { Quad } from './rdf.js';

/** The part of ldfetch that the library uses: pass your own instance to configure caching or headers. */
export interface RdfLoader {
  get(url: string): Promise<{ triples: Quad[]; prefixes?: Record<string, string>; messages?: Quad[][]; url: string }>;
}

export interface LoadedDocument {
  store: Store;
  /** The URL after redirects: the base IRI of the document. */
  url: string;
  /** The messages of an RDF Message Log, else empty. */
  messages: Quad[][];
  prefixes: Record<string, string>;
}

const loaders = new Map<string, Promise<RdfLoader>>();

/** The shared ldfetch of the library. It reads Turtle, TriG, N-Triples, N-Quads, JSON-LD, RDF/XML, RDFa, Jelly, … and RDF Message Logs. */
export function defaultLoader(options: { localFiles?: boolean; headers?: Record<string, string> } = {}): Promise<RdfLoader> {
  const key = JSON.stringify([!!options.localFiles, options.headers ?? null]);
  let loader = loaders.get(key);
  if (!loader) {
    loader = import('ldfetch').then(({ default: LdFetch }) => {
      const config: { localFiles: boolean; headers?: Record<string, string> } = { localFiles: !!options.localFiles };
      if (options.headers) config.headers = options.headers;
      return new LdFetch(config) as RdfLoader;
    });
    loaders.set(key, loader);
  }
  return loader;
}

/** Dereference a metadata document (`http(s):` or, when allowed, `file:`) with ldfetch. */
export async function loadDocument(
  url: string,
  options: { loader?: RdfLoader; localFiles?: boolean; headers?: Record<string, string> } = {},
): Promise<LoadedDocument> {
  const loader = options.loader ?? (await defaultLoader(options));
  const response = await loader.get(url);
  return {
    store: new Store(response.triples),
    url: response.url,
    messages: response.messages ?? [],
    prefixes: response.prefixes ?? {},
  };
}
