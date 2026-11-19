import { iriToPath, localChunks, localEtag, readLocalBytes } from '../platform.js';

export interface DataContext {
  fetch: typeof fetch;
  /** Whether `file:` IRIs may be read. */
  allowLocal: boolean;
}

export interface DataResponse {
  /** The server said nothing changed since the given ETag. */
  notModified: boolean;
  etag?: string;
  chunks(): AsyncIterable<Uint8Array>;
  bytes(): Promise<Uint8Array>;
}

async function* readStream(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return concat(parts);
}

/** Open the data file of an external source, over HTTP or, when allowed, from disk. */
export async function openData(
  iri: string,
  ctx: DataContext,
  options: { etag?: string; signal?: AbortSignal } = {},
): Promise<DataResponse> {
  if (/^https?:/i.test(iri)) {
    const headers: Record<string, string> = {};
    if (options.etag) headers['If-None-Match'] = options.etag;
    const response = await ctx.fetch(iri, { headers, signal: options.signal });
    if (response.status === 304) {
      return { notModified: true, etag: options.etag, chunks: async function* () {}, bytes: async () => new Uint8Array() };
    }
    if (!response.ok) throw new Error(`could not fetch the data file ${iri}: HTTP ${response.status}`);
    return {
      notModified: false,
      etag: response.headers.get('etag') ?? undefined,
      chunks: () => (response.body ? readStream(response.body) : (async function* () { yield new Uint8Array(await response.arrayBuffer()); })()),
      bytes: async () => new Uint8Array(await response.arrayBuffer()),
    };
  }
  if (/^file:/i.test(iri)) {
    if (!ctx.allowLocal) {
      throw new Error(`the data file ${iri} is a local file; pass { localFiles: true } to allow reading local files`);
    }
    const path = await iriToPath(iri);
    const etag = await localEtag(path);
    if (options.etag && options.etag === etag) {
      return { notModified: true, etag, chunks: async function* () {}, bytes: async () => new Uint8Array() };
    }
    return { notModified: false, etag, chunks: () => localChunks(path), bytes: () => readLocalBytes(path) };
  }
  throw new Error(`cannot read the data file ${JSON.stringify(iri)}: it is not an absolute http(s) or file IRI`);
}

/** Decode chunks of bytes as text in the given encoding. */
export async function* decodeChunks(chunks: AsyncIterable<Uint8Array>, encoding: string): AsyncIterable<string> {
  const decoder = new TextDecoder(encoding);
  for await (const chunk of chunks) {
    const piece = decoder.decode(chunk, { stream: true });
    if (piece) yield piece;
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}
