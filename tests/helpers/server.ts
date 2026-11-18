import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.ttl': 'text/turtle',
  '.trig': 'application/trig',
  '.jsonld': 'application/ld+json',
  '.csv': 'text/csv',
  '.arrows': 'application/vnd.apache.arrow.stream',
  '.arrow': 'application/vnd.apache.arrow.file',
  '.parquet': 'application/vnd.apache.parquet',
};

export interface RequestLog {
  method: string;
  path: string;
  status: number;
  ifNoneMatch?: string;
  range?: string;
}

export interface MockServer {
  /** `http://127.0.0.1:<port>` */
  url: string;
  requests: RequestLog[];
  close(): Promise<void>;
}

/**
 * A mock web server for the tests: serves the files of a directory with a content type and
 * an ETag, answers conditional requests with `304`, and byte ranges with `206` or `416`, like
 * a real file server does. `options.ignoreRange` makes it answer a Range request with `200`.
 */
export async function startServer(root: string, options: { ignoreRange?: boolean; maxAge?: number } = {}): Promise<MockServer> {
  const requests: RequestLog[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const log: RequestLog = { method: req.method ?? 'GET', path, status: 200, ifNoneMatch: req.headers['if-none-match'], range: req.headers.range };
    requests.push(log);
    const finish = (status: number, body?: Buffer, headers: Record<string, string> = {}) => {
      log.status = status;
      res.writeHead(status, headers);
      res.end(body);
    };
    try {
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) return finish(403);
      const info = await stat(file);
      if (!info.isFile()) return finish(404);
      const etag = `"${info.size}-${Math.floor(info.mtimeMs)}"`;
      const common: Record<string, string> = {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      };
      if (options.maxAge !== undefined) common['Cache-Control'] = `max-age=${options.maxAge}`;
      if (req.headers['if-none-match'] === etag) return finish(304, undefined, { ETag: etag });
      const body = await readFile(file);
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      if (range && !options.ignoreRange) {
        const start = Number(range[1]);
        if (start >= body.length) return finish(416, undefined, { ...common, 'Content-Range': `bytes */${body.length}` });
        return finish(206, body.subarray(start), { ...common, 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` });
      }
      finish(200, body, common);
    } catch {
      finish(404);
    }
  };
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
