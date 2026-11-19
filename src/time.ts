/**
 * Times of a source: `xsd:dateTimeStamp` values, compared as moments.
 *
 * Instants are `bigint` nanoseconds since the Unix epoch, so that Parquet and Arrow
 * timestamps in nanoseconds keep their precision. Fractions beyond nanoseconds are
 * truncated.
 */

export type Instant = bigint;

const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_DAY = 86_400n * NS_PER_SECOND;

/** The parts of a time as written, with its timezone offset in minutes. */
export interface ParsedTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Fraction of the second in nanoseconds. */
  nanos: number;
  /** Offset to UTC in minutes. */
  offset: number;
}

const TIME_RE =
  /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parse an `xsd:dateTimeStamp`; `null` when it is not one (no timezone, 30 February, …). */
export function parseTime(text: string): ParsedTime | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const endOfDay = hour === 24 && minute === 0 && second === 0 && !(m[7] && /[1-9]/.test(m[7]));
  if (!endOfDay && (hour > 23 || minute > 59 || second > 59)) return null;
  const nanos = m[7] ? Number(m[7].slice(0, 9).padEnd(9, '0')) : 0;
  let offset = 0;
  if (m[8] !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (oh > 14 || om > 59) return null;
    offset = sign * (oh * 60 + om);
  }
  return { year, month, day, hour, minute, second, nanos, offset };
}

/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

/** Nanoseconds of the local date and time, as if it were UTC. */
function localNs(t: ParsedTime): bigint {
  const days = BigInt(daysFromCivil(t.year, t.month, t.day));
  const seconds = BigInt(t.hour * 3600 + t.minute * 60 + t.second);
  return days * NS_PER_DAY + seconds * NS_PER_SECOND + BigInt(t.nanos);
}

function fromLocalNs(ns: bigint, offset: number): ParsedTime {
  let days = ns / NS_PER_DAY;
  let rest = ns % NS_PER_DAY;
  if (rest < 0n) {
    rest += NS_PER_DAY;
    days -= 1n;
  }
  const [year, month, day] = civilFromDays(Number(days));
  const totalSeconds = Number(rest / NS_PER_SECOND);
  return {
    year,
    month,
    day,
    hour: Math.floor(totalSeconds / 3600),
    minute: Math.floor((totalSeconds % 3600) / 60),
    second: totalSeconds % 60,
    nanos: Number(rest % NS_PER_SECOND),
    offset,
  };
}

/** The moment a parsed time stands for. */
export function timeToInstant(t: ParsedTime): Instant {
  return localNs(t) - BigInt(t.offset) * 60n * NS_PER_SECOND;
}

/** The instant of an `xsd:dateTimeStamp`; throws when the text is not one. */
export function instantOf(text: string): Instant {
  const parsed = parseTime(text);
  if (!parsed) throw new Error(`not an xsd:dateTimeStamp: ${JSON.stringify(text)}`);
  return timeToInstant(parsed);
}

export function tryInstantOf(text: string): Instant | null {
  const parsed = parseTime(text);
  return parsed ? timeToInstant(parsed) : null;
}

/** The instant of a `Date` or of an `xsd:dateTimeStamp` (which needs a timezone). */
export function toInstant(value: string | Date): Instant {
  if (value instanceof Date) return BigInt(value.getTime()) * 1_000_000n;
  const instant = tryInstantOf(value);
  if (instant === null) throw new RangeError(`not an xsd:dateTimeStamp (it needs a timezone): ${JSON.stringify(value)}`);
  return instant;
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

/** Write a parsed time in its own timezone; the fraction only when it has one. */
export function formatTime(t: ParsedTime): string {
  const year = (t.year < 0 ? '-' : '') + pad(t.year, 4);
  const fraction = t.nanos ? '.' + pad(t.nanos, 9).replace(/0+$/, '') : '';
  let zone = 'Z';
  if (t.offset !== 0) {
    zone = (t.offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(t.offset) / 60)) + ':' + pad(Math.abs(t.offset) % 60);
  }
  return `${year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}${fraction}${zone}`;
}

/** An instant as UTC text (`…Z`). */
export function formatInstant(instant: Instant): string {
  return formatTime(fromLocalNs(instant, 0));
}

/** An `xsd:duration`, with a sign and its calendar and clock parts. */
export interface Duration {
  negative: boolean;
  years: number;
  months: number;
  days: number;
  /** Hours, minutes and seconds together, in nanoseconds. */
  clockNs: bigint;
}

const DURATION_RE = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?)?$/;

export function parseDuration(text: string): Duration | null {
  const m = DURATION_RE.exec(text);
  if (!m || text.endsWith('P') || text.endsWith('T')) return null;
  if (!m.slice(2, 8).some((part) => part !== undefined)) return null;
  const fraction = m[8] ? BigInt(m[8].slice(0, 9).padEnd(9, '0')) : 0n;
  const clockNs =
    BigInt(m[5] ?? 0) * 3600n * NS_PER_SECOND +
    BigInt(m[6] ?? 0) * 60n * NS_PER_SECOND +
    BigInt(m[7] ?? 0) * NS_PER_SECOND +
    fraction;
  return {
    negative: m[1] === '-',
    years: Number(m[2] ?? 0),
    months: Number(m[3] ?? 0),
    days: Number(m[4] ?? 0),
    clockNs,
  };
}

/**
 * Step `n` of a time grid: `base + n × step`, with every part of the duration multiplied
 * by `n` and added as XML Schema does: months first (a day past the end of the month
 * becomes its last day), then days and the clock.
 */
export function gridTime(base: ParsedTime, step: Duration, n: bigint): ParsedTime {
  const sign = step.negative ? -1n : 1n;
  const totalMonths = (BigInt(step.years) * 12n + BigInt(step.months)) * n * sign;
  const monthIndex = BigInt(base.year) * 12n + BigInt(base.month - 1) + totalMonths;
  const year = Number(monthIndex >= 0n ? monthIndex / 12n : (monthIndex - 11n) / 12n);
  const month = Number(monthIndex - BigInt(year) * 12n) + 1;
  const day = Math.min(base.day, daysInMonth(year, month));
  const moved: ParsedTime = { ...base, year, month, day };
  const delta = (BigInt(step.days) * NS_PER_DAY + step.clockNs) * n * sign;
  return fromLocalNs(localNs(moved) + delta, base.offset);
}

/** The length of a fixed duration (days and clock only) in milliseconds, e.g. for polling. */
export function durationToMs(text: string): number {
  const d = parseDuration(text);
  if (!d || d.years || d.months) throw new Error(`not a fixed xsd:duration: ${JSON.stringify(text)}`);
  const ms = Number((BigInt(d.days) * NS_PER_DAY + d.clockNs) / 1_000_000n);
  return d.negative ? -ms : ms;
}
