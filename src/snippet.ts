import { Store } from 'n3';
import { buildStore } from './create.js';
import { NotWritableError } from './errors.js';
import { parseSnippet } from './metadata.js';
import { isExternalKind } from './ns.js';
import { iriToPath, localEtag, pathToIri, readLocalText } from './platform.js';
import type { Dataset } from './rdf.js';
import { parseRdf } from './rdf.js';
import { ACCEPT, ReadableSnippet, type Origin, type SnippetContext } from './readable.js';
import type { UnitConverter } from './units.js';
import type { CreateOptions } from './types.js';
import { WritableSnippet } from './writable.js';

export interface FetchOptions {
  /** IRI of the snippet, if the document has several. */
  snippet?: string;
  /** A custom fetch, e.g. with authentication. */
  fetch?: typeof fetch;
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
  localFiles?: boolean;
  unitConverter?: UnitConverter;
}

const defaultFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export class Snippet {
  /** Fetch a remote snippet over HTTP(S). */
  static async fetch(source: string | URL, options: FetchOptions = {}): Promise<ReadableSnippet> {
    const url = source instanceof URL ? source.href : source;
    if (!/^https?:/i.test(url)) throw new Error('Snippet.fetch reads http(s) URLs; use Snippet.open for a local file');
    const doFetch = options.fetch ?? defaultFetch;
    const response = await doFetch(url, { headers: { Accept: ACCEPT } });
    if (!response.ok) throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
    const baseIRI = response.url || url;
    const store = await parseRdf(await response.text(), { contentType: response.headers.get('content-type'), filename: url, baseIRI });
    const ctx: SnippetContext = {
      fetch: doFetch,
      allowLocal: options.localFiles ?? false,
      baseIRI,
      snippet: options.snippet,
      converter: options.unitConverter,
    };
    const origin: Origin = { type: 'http', url, etag: response.headers.get('etag') ?? undefined };
    return new ReadableSnippet(store, parseSnippet(store, options.snippet), origin, ctx);
  }

  /** Open a snippet from a local file (Node) or an RDF/JS `Dataset`. */
  static async open(source: string | Dataset, options: OpenOptions & { write: true }): Promise<WritableSnippet>;
  static async open(source: string | Dataset, options?: OpenOptions): Promise<ReadableSnippet>;
  static async open(source: string | Dataset, options: OpenOptions = {}): Promise<ReadableSnippet | WritableSnippet> {
    let store: Store;
    let origin: Origin;
    let baseIRI = options.baseIRI;
    let path: string | undefined;
    if (typeof source === 'string') {
      path = /^file:/i.test(source) ? await iriToPath(source) : source;
      baseIRI = await pathToIri(path);
      store = await parseRdf(await readLocalText(path), { filename: path, baseIRI });
      origin = { type: 'file', path, etag: await localEtag(path) };
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
    };
    const parsed = parseSnippet(store, options.snippet);
    if (!options.write) return new ReadableSnippet(store, parsed, origin, ctx);

    let dataPath: string | undefined;
    if (isExternalKind(parsed.metadata.kind)) {
      const iri = new ReadableSnippet(store, parsed, origin, ctx).dataFileIri();
      if (!/^file:/i.test(iri)) throw new NotWritableError(`cannot write to ${iri}: only local data files can be written`);
      dataPath = await iriToPath(iri);
    }
    return WritableSnippet.start(store, parsed, { type: 'dataset' }, ctx, { metadataFile: path, dataPath, fresh: false });
  }

  /**
   * Create a new snippet to append to. With `file`, the metadata is written to that file
   * now and after every `append`; without it, use `serialize()`.
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
    // A Parquet file is written once, when the snippet is closed; it is frozen then.
    const store = buildStore(options.kind === 'Parquet' ? { ...options, mutable: true } : options, dataFileRef);
    const ctx: SnippetContext = { fetch: defaultFetch, allowLocal: true, baseIRI, snippet: options.id };
    const snippet = await WritableSnippet.start(store, parseSnippet(store, options.id), { type: 'dataset' }, ctx, {
      metadataFile,
      dataPath,
      fresh: true,
      prefixes: options.prefixes,
    });
    await snippet.persistNow();
    return snippet;
  }
}
