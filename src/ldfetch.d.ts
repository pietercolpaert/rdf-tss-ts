declare module 'ldfetch' {
  import type { Quad } from '@rdfjs/types';

  export interface LdfetchResponse {
    triples: Quad[];
    prefixes: Record<string, string>;
    /** The messages of an RDF Message Log; empty for another document. */
    messages: Quad[][];
    statusCode: number;
    /** The URL after redirects. */
    url: string;
  }

  export interface LdfetchOptions {
    headers?: Record<string, string>;
    proxy?: string;
    /** `false`, `true` or a cache configuration. Node only: browsers have their own HTTP cache. */
    cache?: unknown;
    /** Allow `file:` URLs. */
    localFiles?: boolean;
  }

  export default class LdFetch {
    constructor(options?: LdfetchOptions);
    get(url: string): Promise<LdfetchResponse>;
  }
}
