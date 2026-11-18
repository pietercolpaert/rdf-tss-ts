import { Store } from 'n3';
import { buildStore } from './create.js';
import { NotWritableError } from './errors.js';
import { loadDocument, type RdfLoader } from './loader.js';
import { parseSnippet } from './metadata.js';
import { isExternalKind } from './ns.js';
import { iriToPath, pathToIri } from './platform.js';
import type { Dataset } from './rdf.js';
import { ReadableSnippet, type Origin, type SnippetContext } from './readable.js';
import type { UnitConverter } from './units.js';
import type { CreateOptions } from './types.js';
import { WritableSnippet } from './writable.js';

export interface FetchOptions {
  /** IRI of the snippet, if the document has several. */
  snippet?: string;
  /** A custom fetch for the data files, e.g. with authentication. */
  fetch?: typeof fetch;
  /** Reads the metadata document: your own ldfetch, e.g. with another cache. Default: a shared ldfetch. */
  loader?: RdfLoader;
  /** Headers for the requests of the default ldfetch, e.g. `Authorization`. */
  headers?: Record<string, string>;
  /** Whether the document may refer to local files. Default `false`. */
  localFiles?: boolean;
  /** Converts units; default: eyemind with QUDT. */
  unitConverter?: UnitConverter;
}

export interface OpenOptions {
  /** IRI of the snippet, if the document has several. */
  snippet?: string;
  /** Open for appending: takes a lock and returns a `WritableSnippet`. Default `false`. */
  write?: boolean;
  /** Base IRI of a `Dataset`, to resolve a relative `tss:dataFile`. */
  baseIRI?: string;
  fetch?: typeof fetch;
  loader?: RdfLoader;
  headers?: Record<string, string>;
  localFiles?: boolean;
  unitConverter?: UnitConverter;
}

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export class Snippet {
  /** Fetch a remote snippet over HTTP(S), with ldfetch: any RDF serialization, and RDF Message Logs. */
  static async fetch(source: string | URL, options: FetchOptions = {}): Promise<ReadableSnippet> {
    const url = source instanceof URL ? source.href : source;
    if (!/^https?:/i.test(url)) throw new Error('Snippet.fetch reads http(s) URLs; use Snippet.open for a local file');
    const document = await loadDocument(url, { loader: options.loader, headers: options.headers });
    const ctx: SnippetContext = {
      fetch: options.fetch ?? defaultFetch,
      allowLocal: options.localFiles ?? false,
      baseIRI: document.url,
      snippet: options.snippet,
      converter: options.unitConverter,
      loader: options.loader,
      headers: options.headers,
    };
    const origin: Origin = { type: 'http', url };
    return new ReadableSnippet(document.store, parseSnippet(document.store, options.snippet), origin, ctx, document.messages);
  }

  /** Open a snippet from a local file (Node) or an RDF/JS `Dataset`. */
  static async open(source: string | Dataset, options: OpenOptions & { write: true }): Promise<WritableSnippet>;
  static async open(source: string | Dataset, options?: OpenOptions): Promise<ReadableSnippet>;
  static async open(source: string | Dataset, options: OpenOptions = {}): Promise<ReadableSnippet | WritableSnippet> {
    let store: Store;
    let messages: ReadableSnippet['messages'] = [];
    let origin: Origin;
    let baseIRI = options.baseIRI;
    let path: string | undefined;
    if (typeof source === 'string') {
      path = /^file:/i.test(source) ? await iriToPath(source) : source;
      baseIRI = await pathToIri(path);
      const document = await loadDocument(baseIRI, { loader: options.loader, localFiles: true });
      store = document.store;
      messages = document.messages;
      origin = { type: 'file', url: baseIRI, path };
    } else {
      store = source instanceof Store ? source : new Store([...source]);
      origin = { type: 'dataset' };
    }
    const ctx: SnippetContext = {
      fetch: options.fetch ?? defaultFetch,
      allowLocal: path !== undefined || (options.localFiles ?? false) || !!baseIRI?.startsWith('file:'),
      baseIRI,
      snippet: options.snippet,
      converter: options.unitConverter,
      loader: options.loader,
      headers: options.headers,
    };
    const parsed = parseSnippet(store, options.snippet);
    if (!options.write) return new ReadableSnippet(store, parsed, origin, ctx, messages);

    let dataPath: string | undefined;
    if (isExternalKind(parsed.metadata.kind)) {
      const iri = new ReadableSnippet(store, parsed, origin, ctx).dataFileIri();
      if (!/^file:/i.test(iri)) throw new NotWritableError(`cannot write to ${iri}: only local data files can be written`);
      dataPath = await iriToPath(iri);
    }
    return WritableSnippet.start(store, parsed, { type: 'dataset' }, ctx, { metadataFile: path, dataPath, fresh: false }, messages);
  }

  /**
   * Create a new growing snippet to append to. With `file`, the metadata is written to that
   * file now (an RDF Message Log for an embedded RDF snippet, to which messages are appended);
   * without it, use `serialize()`.
   */
  static async create(options: CreateOptions): Promise<WritableSnippet> {
    const { resolve, relative, dirname, basename, sep } = await import('node:path');
    let dataFileRef: string | undefined;
    let dataPath: string | undefined;
    let baseIRI: string | undefined;
    const metadataFile = options.file ? resolve(options.file) : undefined;
    if (isExternalKind(options.kind)) {
      if (!options.dataFile) throw new Error(`a ${options.kind} snippet needs a dataFile`);
      dataPath = resolve(options.dataFile);
      if (metadataFile) {
        dataFileRef = relative(dirname(metadataFile), dataPath).split(sep).join('/');
        baseIRI = await pathToIri(metadataFile);
      } else {
        dataFileRef = basename(dataPath);
        baseIRI = await pathToIri(dataPath);
      }
    } else if (metadataFile) {
      baseIRI = await pathToIri(metadataFile);
    }
    // A Parquet file is written once, when the snippet is closed; it is immutable then.
    const store = buildStore(options.immutable && options.kind !== 'Parquet' ? options : { ...options, immutable: false }, dataFileRef);
    const ctx: SnippetContext = { fetch: defaultFetch, allowLocal: true, baseIRI, snippet: options.id };
    const snippet = await WritableSnippet.start(
      store,
      parseSnippet(store, options.id),
      { type: 'dataset' },
      ctx,
      { metadataFile, dataPath, fresh: true, prefixes: options.prefixes, summaries: options.summaries },
    );
    await snippet.persistNow();
    return snippet;
  }
}
