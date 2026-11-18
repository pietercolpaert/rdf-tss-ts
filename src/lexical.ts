import { XSD } from './ns.js';
import { Decimal } from './decimal.js';
import { parseTime, timeToInstant } from './time.js';

const x = (name: string) => XSD + name;

const INTEGER_RANGES: Record<string, [bigint | null, bigint | null]> = {
  [x('integer')]: [null, null],
  [x('long')]: [-(2n ** 63n), 2n ** 63n - 1n],
  [x('int')]: [-(2n ** 31n), 2n ** 31n - 1n],
  [x('short')]: [-(2n ** 15n), 2n ** 15n - 1n],
  [x('byte')]: [-128n, 127n],
  [x('nonNegativeInteger')]: [0n, null],
  [x('positiveInteger')]: [1n, null],
  [x('nonPositiveInteger')]: [null, 0n],
  [x('negativeInteger')]: [null, -1n],
  [x('unsignedLong')]: [0n, 2n ** 64n - 1n],
  [x('unsignedInt')]: [0n, 2n ** 32n - 1n],
  [x('unsignedShort')]: [0n, 65535n],
  [x('unsignedByte')]: [0n, 255n],
};

const FLOAT_RE = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/;
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_RE = /^[+-]?\d+$/;
const DATE_RE = /^(-?\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const DATETIME_RE = /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export const isIntegerDatatype = (datatype: string) => datatype in INTEGER_RANGES;
export const isFloatDatatype = (datatype: string) => datatype === x('double') || datatype === x('float');
export const isNumericDatatype = (datatype: string) =>
  isIntegerDatatype(datatype) || isFloatDatatype(datatype) || datatype === x('decimal');

function realDay(year: string, month: string, day: string): boolean {
  const m = Number(month);
  const d = Number(day);
  const y = Number(year);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return d <= days;
}

/**
 * Whether a text is in the lexical form of a datatype. The datatypes of spec § 4.1 are
 * checked; any other datatype, such as `xsd:string`, accepts any text.
 */
export function isValidLexical(datatype: string, text: string): boolean {
  if (isFloatDatatype(datatype)) return FLOAT_RE.test(text);
  if (datatype === x('decimal')) return DECIMAL_RE.test(text);
  const range = INTEGER_RANGES[datatype];
  if (range) {
    if (!INTEGER_RE.test(text)) return false;
    const value = BigInt(text);
    return (range[0] === null || value >= range[0]) && (range[1] === null || value <= range[1]);
  }
  if (datatype === x('boolean')) return ['true', 'false', '1', '0'].includes(text);
  if (datatype === x('dateTimeStamp')) return parseTime(text) !== null;
  if (datatype === x('dateTime')) {
    const m = DATETIME_RE.exec(text);
    if (!m) return false;
    if (!realDay(m[1], m[2], m[3])) return false;
    return Number(m[4]) <= 24 && Number(m[5]) <= 59 && Number(m[6]) <= 59;
  }
  if (datatype === x('date')) {
    const m = DATE_RE.exec(text);
    return !!m && realDay(m[1], m[2], m[3]);
  }
  return true;
}

/** A JavaScript value for a lexical form: numbers, `bigint` beyond 2^53, booleans, dates or the text. */
export function toNativeValue(datatype: string, text: string): number | bigint | boolean | Date | string {
  if (isIntegerDatatype(datatype)) {
    const big = BigInt(text);
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  }
  if (isFloatDatatype(datatype)) {
    if (text === 'INF' || text === '+INF') return Infinity;
    if (text === '-INF') return -Infinity;
    return Number(text);
  }
  if (datatype === x('decimal')) return Decimal.parse(text)?.toNumber() ?? Number(text);
  if (datatype === x('boolean')) return text === 'true' || text === '1';
  if (datatype === x('dateTimeStamp') || datatype === x('dateTime')) {
    const parsed = parseTime(/(Z|[+-]\d{2}:\d{2})$/.test(text) ? text : text + 'Z');
    if (parsed) return new Date(Number(timeToInstant(parsed) / 1_000_000n));
  }
  if (datatype === x('date')) {
    const date = new Date(text.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isNaN(date.getTime())) return date;
  }
  return text;
}

/** The XSD lexical form of a JavaScript number. */
export function numberToLexical(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'INF';
  if (value === -Infinity) return '-INF';
  return String(value);
}

/** The first `n` significant digits of a number, without floating point noise. */
export function roundNumber(value: number, digits = 15): number {
  return Number.isFinite(value) ? Number(value.toPrecision(digits)) : value;
}
