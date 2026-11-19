/**
 * Everything that needs Node: local files and process information. These modules are
 * only imported when a local file is used, so the rest of the library runs in browsers.
 */

export const isNode = typeof process !== 'undefined' && !!process.versions?.node;

function requireNode(what: string): void {
  if (!isNode) throw new Error(`${what} is only available in Node; use Source.fetch or an RDF/JS Dataset in the browser`);
}

export async function pathToIri(path: string): Promise<string> {
  requireNode('Opening a local file');
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  return pathToFileURL(resolve(path)).href;
}

export async function iriToPath(iri: string): Promise<string> {
  requireNode('Reading a local file');
  const { fileURLToPath } = await import('node:url');
  return fileURLToPath(iri);
}

export async function readLocalText(path: string): Promise<string> {
  requireNode('Reading a local file');
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

export async function readLocalBytes(path: string): Promise<Uint8Array> {
  requireNode('Reading a local file');
  const { readFile } = await import('node:fs/promises');
  return new Uint8Array(await readFile(path));
}

export async function* localChunks(path: string): AsyncIterable<Uint8Array> {
  requireNode('Reading a local file');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(path)) yield chunk as Uint8Array;
}

/** A cheap fingerprint of a file that changes when it is written. */
export async function localEtag(path: string): Promise<string> {
  requireNode('Reading a local file');
  const { stat } = await import('node:fs/promises');
  const s = await stat(path);
  return `${s.size}-${s.mtimeMs}`;
}

/**
 * The bytes of a file after the first `offset` ones, like a Range request: `bytes` when the
 * file grew, `same` when it is as long as the offset, `shrunk` when it is shorter.
 */
export async function readFromOffset(
  path: string,
  offset: number,
): Promise<{ status: 'bytes'; bytes: Uint8Array } | { status: 'same' } | { status: 'shrunk' }> {
  requireNode('Reading a local file');
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size < offset) return { status: 'shrunk' };
    if (size === offset) return { status: 'same' };
    const bytes = new Uint8Array(size - offset);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    return { status: 'bytes', bytes: bytes.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

export async function localSize(path: string): Promise<number> {
  requireNode('Reading a local file');
  const { stat } = await import('node:fs/promises');
  return (await stat(path)).size;
}

export async function fileExists(path: string): Promise<boolean> {
  requireNode('Reading a local file');
  const { stat } = await import('node:fs/promises');
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write a file in one step: to a temporary file next to it, then a rename. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  requireNode('Writing a file');
  const { writeFile, rename, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

export async function appendLocal(path: string, data: string | Uint8Array): Promise<void> {
  requireNode('Writing a file');
  const { open, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a');
  try {
    await handle.appendFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Replace the end of a file: cut it at `size` bytes and append `data`. */
export async function truncateAndAppend(path: string, size: number, data: Uint8Array): Promise<void> {
  requireNode('Writing a file');
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r+');
  try {
    await handle.truncate(size);
    await handle.write(data, 0, data.length, size);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readHead(path: string, length: number): Promise<Uint8Array> {
  requireNode('Reading a local file');
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readTail(path: string, length: number): Promise<Uint8Array> {
  requireNode('Reading a local file');
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const count = Math.min(length, size);
    const buffer = new Uint8Array(count);
    await handle.read(buffer, 0, count, size - count);
    return buffer;
  } finally {
    await handle.close();
  }
}

/** A lock file next to a file; throws `LockError` when another live process holds it. */
export async function acquireLock(path: string, makeError: (message: string) => Error): Promise<() => Promise<void>> {
  requireNode('Locking a file');
  const { open, readFile, rm, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.write(JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: { pid?: number } = {};
      try {
        holder = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch {
        // an unreadable lock file is treated as stale below
      }
      if (holder.pid && processAlive(holder.pid)) {
        throw makeError(`${path} is being written to by process ${holder.pid} (lock file ${lockPath})`);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw makeError(`could not lock ${path}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
