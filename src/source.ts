import { Store } from 'n3';
import { buildStore } from './create.js';
import { NotWritableError } from './errors.js';
import { loadDocument, type RdfLoader } from './loader.js';
import { parseSource } from './metadata.js';
import { isExternalKind } from './ns.js';
import { iriToPath, pathToIri } from './platform.js';
import type { Dataset } from './rdf.js';
import { ReadableSource, type Origin, type SourceContext } from './readable.js';
import type { UnitConverter } from './units.js';
import type { CreateOptions } from './types.js';
import { WritableSource } from './writable.js';

export interface FetchOptions {
  /** IRI of the source, if the document has several. */
  source?: string;
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
  /** IRI of the source, if the document has several. */
  source?: string;
  /** Open for appending: takes a lock and returns a `WritableSource`. Default `false`. */
  write?: boolean;
  /**
   * The IRI of the metadata document of a `Dataset`: the base of a relative `tss:dataFile`, and
   * of the default field properties of an embedded source.
   */
  baseIRI?: string;
  fetch?: typeof fetch;
  loader?: RdfLoader;
  headers?: Record<string, string>;
  localFiles?: boolean;
  unitConverter?: UnitConverter;
}

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export class Source {
  /** Fetch a remote source over HTTP(S), with ldfetch: any RDF serialization, and RDF Message Logs. */
  static async fetch(url: string | URL, options: FetchOptions = {}): Promise<ReadableSource> {
    const href = url instanceof URL ? url.href : url;
    if (!/^https?:/i.test(href)) throw new Error('Source.fetch reads http(s) URLs; use Source.open for a local file');
    const document = await loadDocument(href, { loader: options.loader, headers: options.headers });
    const ctx: SourceContext = {
      fetch: options.fetch ?? defaultFetch,
      allowLocal: options.localFiles ?? false,
      baseIRI: document.url,
      source: options.source,
      converter: options.unitConverter,
      loader: options.loader,
      headers: options.headers,
    };
    const origin: Origin = { type: 'http', url: href };
    const parsed = parseSource(document.store, { source: options.source, baseIRI: document.url });
    return new ReadableSource(document.store, parsed, origin, ctx, document.messages);
  }

  /** Open a source from a local file (Node) or an RDF/JS `Dataset`. */
  static async open(location: string | Dataset, options: OpenOptions & { write: true }): Promise<WritableSource>;
  static async open(location: string | Dataset, options?: OpenOptions): Promise<ReadableSource>;
  static async open(location: string | Dataset, options: OpenOptions = {}): Promise<ReadableSource | WritableSource> {
    let store: Store;
    let messages: ReadableSource['messages'] = [];
    let origin: Origin;
    let baseIRI = options.baseIRI;
    let path: string | undefined;
    if (typeof location === 'string') {
      path = /^file:/i.test(location) ? await iriToPath(location) : location;
      baseIRI = await pathToIri(path);
      const document = await loadDocument(baseIRI, { loader: options.loader, localFiles: true });
      store = document.store;
      messages = document.messages;
      origin = { type: 'file', url: baseIRI, path };
    } else {
      store = location instanceof Store ? location : new Store([...location]);
      origin = { type: 'dataset' };
    }
    const ctx: SourceContext = {
      fetch: options.fetch ?? defaultFetch,
      allowLocal: path !== undefined || (options.localFiles ?? false) || !!baseIRI?.startsWith('file:'),
      baseIRI,
      source: options.source,
      converter: options.unitConverter,
      loader: options.loader,
      headers: options.headers,
    };
    const parsed = parseSource(store, { source: options.source, baseIRI });
    if (!options.write) return new ReadableSource(store, parsed, origin, ctx, messages);

    let dataPath: string | undefined;
    if (isExternalKind(parsed.metadata.kind)) {
      const iri = new ReadableSource(store, parsed, origin, ctx).dataFileIri();
      if (!/^file:/i.test(iri)) throw new NotWritableError(`cannot write to ${iri}: only local data files can be written`);
      dataPath = await iriToPath(iri);
    }
    return WritableSource.start(store, parsed, { type: 'dataset' }, ctx, { metadataFile: path, dataPath, fresh: false }, messages);
  }

  /**
   * Create a new growing source to append to. With `file`, the metadata is written to that
   * file now (an RDF Message Log for an embedded RDF source, to which messages are appended);
   * without it, use `serialize()`.
   */
  static async create(options: CreateOptions): Promise<WritableSource> {
    const { resolve, relative, dirname, basename, sep } = await import('node:path');
    let dataFileRef: string | undefined;
    let dataPath: string | undefined;
    let baseIRI: string | undefined;
    const metadataFile = options.file ? resolve(options.file) : undefined;
    if (isExternalKind(options.kind)) {
      if (!options.dataFile) throw new Error(`a ${options.kind} source needs a dataFile`);
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
    if (options.baseIRI) baseIRI = options.baseIRI;
    // the default field properties of an embedded source are made from the IRI of its document
    if (!baseIRI && !isExternalKind(options.kind) && !options.id.startsWith('_:')) baseIRI = options.id.replace(/#.*$/, '');
    // A Parquet file is written once, when the source is closed; it is immutable then.
    const store = buildStore(options.immutable && options.kind !== 'Parquet' ? options : { ...options, immutable: false }, dataFileRef);
    const ctx: SourceContext = { fetch: defaultFetch, allowLocal: true, baseIRI, source: options.id };
    const source = await WritableSource.start(
      store,
      parseSource(store, { source: options.id, baseIRI }),
      { type: 'dataset' },
      ctx,
      { metadataFile, dataPath, fresh: true, prefixes: options.prefixes, summaries: options.summaries },
    );
    await source.persistNow();
    return source;
  }
}
