import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Snippet, type ReadableSnippet, type Reading, type SnippetKind } from '../src/index.js';
import { startServer, type MockServer } from './helpers/server.js';
import { tempDir, weatherOptions, weatherReadings } from './helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
let server: MockServer;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  server = await startServer(dir);
});
afterEach(async () => {
  await server.close();
  await cleanup();
});

const FAST = { interval: 'PT0.05S' };
const temperatures = (readings: Reading[]) => readings.map((r) => r.get('temperature')?.value);

/** Read with `follow` in the background, collecting until the stream ends. */
function following(snippetPromise: Promise<ReadableSnippet>, options: object = {}) {
  const seen: Reading[] = [];
  const done = (async () => {
    const snippet = await snippetPromise;
    for await (const r of snippet.read({ follow: FAST, ...options })) seen.push(r);
  })();
  const until = async (count: number) => {
    for (let i = 0; i < 400 && seen.length < count; i++) await new Promise((r) => setTimeout(r, 25));
    expect(seen.length).toBeGreaterThanOrEqual(count);
  };
  return { seen, done, until };
}

describe.each<{ kind: SnippetKind; dataFile?: string }>([
  { kind: 'CSV', dataFile: 'f.csv' },
  { kind: 'Arrow', dataFile: 'f.arrows' },
  { kind: 'EmbeddedRDF' },
  { kind: 'EmbeddedJSON' },
])('following a live $kind snippet', ({ kind, dataFile }) => {
  it('returns the existing points, then new ones, and ends when the snippet is frozen', async () => {
    const writer = await Snippet.create({ ...weatherOptions(kind, 'f'), dataFile: dataFile ? join(dir, dataFile) : undefined, file: join(dir, 'f.ttl') });
    await writer.append(weatherReadings.slice(0, 2));

    const reader = following(Snippet.fetch(`${server.url}/f.ttl`));
    await reader.until(2);
    expect(temperatures(reader.seen)).toEqual(['8.4', '8.6']);

    await writer.append(weatherReadings[2]);
    await reader.until(3);
    await writer.append(weatherReadings[3]);
    await writer.close({ freeze: true });
    await reader.done;

    expect(temperatures(reader.seen)).toEqual(['8.4', '8.6', '8.5', '9']);
  });
});

describe('following', () => {
  it('asks the server whether anything changed, instead of downloading again', async () => {
    const writer = await Snippet.create({ ...weatherOptions('CSV', 'c'), dataFile: join(dir, 'c.csv'), file: join(dir, 'c.ttl') });
    await writer.append(weatherReadings.slice(0, 1));
    const reader = following(Snippet.fetch(`${server.url}/c.ttl`));
    await reader.until(1);
    await new Promise((r) => setTimeout(r, 300));
    await writer.close({ freeze: true });
    await reader.done;
    const conditional = server.requests.filter((r) => r.ifNoneMatch);
    expect(conditional.some((r) => r.path === '/c.csv' && r.status === 304)).toBe(true);
    expect(conditional.some((r) => r.path === '/c.ttl' && r.status === 304)).toBe(true);
  });

  it('stops when the signal aborts, without an error', async () => {
    const writer = await Snippet.create({ ...weatherOptions('CSV', 'a'), dataFile: join(dir, 'a.csv'), file: join(dir, 'a.ttl') });
    await writer.append(weatherReadings.slice(0, 1));
    const controller = new AbortController();
    const reader = following(Snippet.fetch(`${server.url}/a.ttl`), { signal: controller.signal });
    await reader.until(1);
    controller.abort();
    await reader.done;
    expect(reader.seen).toHaveLength(1);
    await writer.close();
  });

  it('stops when you stop iterating', async () => {
    const writer = await Snippet.create({ ...weatherOptions('CSV', 'b'), dataFile: join(dir, 'b.csv'), file: join(dir, 'b.ttl') });
    await writer.append(weatherReadings);
    const snippet = await Snippet.fetch(`${server.url}/b.ttl`);
    const seen: string[] = [];
    for await (const r of snippet.read({ follow: FAST })) {
      seen.push(r.time);
      if (seen.length === 2) break;
    }
    expect(seen).toHaveLength(2);
    await writer.close();
  });

  it('ends once a point at or after `until` has been seen', async () => {
    const writer = await Snippet.create({ ...weatherOptions('CSV', 'u'), dataFile: join(dir, 'u.csv'), file: join(dir, 'u.ttl') });
    await writer.append(weatherReadings);
    const snippet = await Snippet.fetch(`${server.url}/u.ttl`);
    const seen: string[] = [];
    for await (const r of snippet.read({ follow: FAST, until: '2026-11-17T12:20:00Z' })) seen.push(r.time);
    expect(seen).toEqual(['2026-11-17T12:00:00Z', '2026-11-17T12:10:00Z']);
    await writer.close();
  });

  it('behaves like a normal read on an immutable snippet', async () => {
    const writer = await Snippet.create({ ...weatherOptions('CSV', 'i'), dataFile: join(dir, 'i.csv'), file: join(dir, 'i.ttl') });
    await writer.append(weatherReadings);
    await writer.close({ freeze: true });
    const snippet = await Snippet.fetch(`${server.url}/i.ttl`);
    const seen: string[] = [];
    for await (const r of snippet.read({ follow: true })) seen.push(r.time);
    expect(seen).toHaveLength(4);
  });

  it('can follow a local file too', async () => {
    const writer = await Snippet.create({ ...weatherOptions('CSV', 'l'), dataFile: join(dir, 'l.csv'), file: join(dir, 'l.ttl') });
    await writer.append(weatherReadings.slice(0, 1));
    const reader = following(Snippet.open(join(dir, 'l.ttl')));
    await reader.until(1);
    await writer.append(weatherReadings.slice(1));
    await reader.until(4);
    await writer.close({ freeze: true });
    await reader.done;
    expect(reader.seen).toHaveLength(4);
  });

  it('does not lose a row that arrives before the writer announces it in the time window', async () => {
    const options = { ...weatherOptions('CSV', 'w'), dataFile: join(dir, 'w.csv'), file: join(dir, 'w.ttl'), from: '2026-11-17T12:00:00Z', until: '2026-11-17T12:05:00Z' };
    const writer = await Snippet.create(options);
    await writer.append(weatherReadings.slice(0, 1));
    const reader = following(Snippet.fetch(`${server.url}/w.ttl`));
    await reader.until(1);
    // the data file is written first, and the window widened right after: simulate a reader in between
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'w.csv'), '2026-11-17T12:10:00Z,8.6,,estimated\n');
    await new Promise((r) => setTimeout(r, 250));
    expect(reader.seen).toHaveLength(1);
    await writer.append(weatherReadings.slice(1, 2).map((r) => ({ ...r, time: '2026-11-17T12:20:00Z' })));
    await writer.close({ freeze: true });
    await reader.done;
    expect(reader.seen.map((r) => r.time)).toEqual(['2026-11-17T12:00:00Z', '2026-11-17T12:10:00Z', '2026-11-17T12:20:00Z']);
  });
});
