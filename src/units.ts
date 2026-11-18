import { Parser } from 'n3';
import { UnitConversionError } from './errors.js';
import { roundNumber } from './lexical.js';
import { QUDT } from './ns.js';
import { isNode } from './platform.js';

/** A conversion of numbers from one unit to another. */
export interface UnitConversion {
  /** The unit the converted numbers are in. */
  unit: string;
  convert(value: number): number;
}

export interface UnitConverter {
  /**
   * The conversion from the unit `from` (a QUDT unit IRI) to `to`: the QUDT normalized
   * (SI) unit when `to` is `'qudt'`, or else a unit IRI.
   */
  conversion(from: string, to: 'qudt' | string): Promise<UnitConversion>;
}

/** The entry point of the eyemind command line, which can also be called in-process. */
export type EyemindMain = (
  argv: string[],
  io: {
    readFile: (name: string) => string;
    stdin: () => string;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  },
) => Promise<number>;

interface Affine {
  /** SI value = scale × value + offset */
  scale: number;
  offset: number;
  /** The SI unit of the unit's dimension. */
  si: string;
}

const QCONV = 'https://eyereasoner.github.io/eyemind/qudt#';
const PROBE = 'urn:tss:probe:';
/** Values eyemind normalizes to find a unit's conversion; far apart, to keep the rounding noise small. */
const PROBE_VALUES = [0, 1000, 2000];
/** Significant digits of a converted value: eyemind computes with binary floating point. */
const DIGITS = 12;

/**
 * Loads eyemind's `main` in Node. The RDF logic profiles of eyemind (`--qudt`) are not
 * exported by its package, so its command line entry is loaded from the installed package.
 */
async function loadEyemindMain(): Promise<EyemindMain> {
  if (!isNode) {
    throw new UnitConversionError('in the browser, pass eyemind\'s main: createEyemindUnitConverter({ main })');
  }
  try {
    const { createRequire } = await import('node:module');
    const { dirname, join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const require = createRequire(import.meta.url);
    const dir = dirname(require.resolve('eyemind/package.json'));
    const module = await import(/* @vite-ignore */ pathToFileURL(join(dir, 'src', 'cli.js')).href);
    return module.main as EyemindMain;
  } catch (error) {
    throw new UnitConversionError(`unit conversion needs the eyemind package (npm install eyemind): ${(error as Error).message}`);
  }
}

/**
 * Converts units with the QUDT profile of eyemind (`eyemind --qudt`). The profile
 * normalizes a quantity to the SI unit of its dimension, using QUDT's multiplier and
 * offset. The converter asks eyemind to normalize the values 0, 1 and 2 of each unit once
 * and derives the (affine) conversion from that, so no reasoning happens per reading.
 */
export class EyemindUnitConverter implements UnitConverter {
  private main?: EyemindMain;
  private readonly cache = new Map<string, Promise<Affine>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { main?: EyemindMain } = {}) {
    this.main = options.main;
  }

  /** eyemind runs one program at a time here. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private affine(unit: string): Promise<Affine> {
    let found = this.cache.get(unit);
    if (!found) {
      found = this.serial(() => this.probe(unit));
      this.cache.set(unit, found);
      found.catch(() => this.cache.delete(unit));
    }
    return found;
  }

  private async probe(unit: string): Promise<Affine> {
    this.main ??= await loadEyemindMain();
    const quantity = (n: number, value: number) => `p:x${n} [ a qudt:QuantityValue ; qudt:numericValue ${value} ; qudt:unit <${unit}> ] .`;
    const input = `@prefix qudt: <${QUDT}> .\n@prefix p: <${PROBE}> .\n${PROBE_VALUES.map((value, n) => `p:s ${quantity(n, value)}`).join('\n')}\n`;
    let out = '';
    let err = '';
    const code = await this.main(['--qudt', '--to', 'turtle', 'probe.ttl'], {
      readFile: () => input,
      stdin: () => input,
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
    });
    if (code !== 0) throw new UnitConversionError(`eyemind could not normalize ${unit}: ${err.trim() || `exit code ${code}`}`);

    const quads = new Parser({ format: 'text/turtle' }).parse(out);
    const byBlank = new Map<string, { source?: string; value?: number; unit?: string }>();
    for (const q of quads) {
      if (q.subject.termType !== 'BlankNode') continue;
      const entry = byBlank.get(q.subject.value) ?? {};
      if (q.predicate.value === QCONV + 'sourceProperty') entry.source = q.object.value;
      if (q.predicate.value === QUDT + 'numericValue') entry.value = Number(q.object.value);
      if (q.predicate.value === QUDT + 'unit') entry.unit = q.object.value;
      byBlank.set(q.subject.value, entry);
    }
    const results = PROBE_VALUES.map((_, n) => [...byBlank.values()].find((e) => e.source === `${PROBE}x${n}`));
    if (results.some((r) => r?.value === undefined || r.unit === undefined)) {
      throw new UnitConversionError(`unknown unit ${unit}: it is not in the QUDT catalog of eyemind`);
    }
    const [y0, y1, y2] = results.map((r) => r!.value!);
    const si = results[0]!.unit!;
    const scale = (y1 - y0) / PROBE_VALUES[1];
    if (Math.abs(y2 - (PROBE_VALUES[2] * scale + y0)) > 1e-9 * Math.max(1, Math.abs(y2))) {
      throw new UnitConversionError(`unit ${unit} is not a linear (affine) unit and cannot be converted`);
    }
    return { scale, offset: y0, si };
  }

  async conversion(from: string, to: 'qudt' | string): Promise<UnitConversion> {
    if (from === to) return { unit: from, convert: (x) => x };
    const source = await this.affine(from);
    if (to === 'qudt') {
      return { unit: source.si, convert: (x) => roundNumber(source.scale * x + source.offset, DIGITS) };
    }
    const target = await this.affine(to);
    if (target.si !== source.si) {
      throw new UnitConversionError(`cannot convert ${from} (SI unit ${source.si}) to ${to} (SI unit ${target.si}): different dimensions`);
    }
    return { unit: to, convert: (x) => roundNumber((source.scale * x + source.offset - target.offset) / target.scale, DIGITS) };
  }
}

export function createEyemindUnitConverter(options: { main?: EyemindMain } = {}): UnitConverter {
  return new EyemindUnitConverter(options);
}

let defaultConverter: UnitConverter | undefined;

/** The converter used when none is given: eyemind with QUDT. */
export function defaultUnitConverter(): UnitConverter {
  return (defaultConverter ??= new EyemindUnitConverter());
}

export function setDefaultUnitConverter(converter: UnitConverter | undefined): void {
  defaultConverter = converter;
}

/**
 * Convert one number from one unit to another with QUDT: `to` is a unit IRI, or `'qudt'`
 * for the normalized (SI) unit. Throws `UnitConversionError` for unknown units and units of
 * different dimensions.
 */
export async function convertUnit(
  value: string,
  from: string,
  to: 'qudt' | string,
  converter: UnitConverter = defaultUnitConverter(),
): Promise<string> {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new UnitConversionError(`${JSON.stringify(value)} is not a number`);
  const conversion = await converter.conversion(from, to);
  return String(roundNumber(conversion.convert(number), DIGITS));
}
