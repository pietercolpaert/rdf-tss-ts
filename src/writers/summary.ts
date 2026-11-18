import { isNumericDatatype, numberToLexical } from '../lexical.js';
import { formatInstant, type Instant } from '../time.js';
import type { FieldMetadata, FieldSummary } from '../types.js';

/** Collects the numbers of a stored summary while points are added. */
export class FieldStats {
  count = 0;
  first?: Instant;
  last?: Instant;
  private readonly numeric: boolean;
  private readonly numbers: number[] = [];
  private min?: { value: number; text: string };
  private max?: { value: number; text: string };

  constructor(readonly field: FieldMetadata) {
    this.numeric = isNumericDatatype(field.datatype);
  }

  add(instant: Instant, text: string): void {
    this.count++;
    if (this.first === undefined || instant < this.first) this.first = instant;
    if (this.last === undefined || instant > this.last) this.last = instant;
    if (!this.numeric) return;
    const value = text === 'INF' ? Infinity : text === '-INF' ? -Infinity : Number(text);
    if (Number.isNaN(value)) return;
    this.numbers.push(value);
    if (!this.min || value < this.min.value) this.min = { value, text };
    if (!this.max || value > this.max.value) this.max = { value, text };
  }

  /** The summary over `total` points in the window, computed at `generatedAt`. */
  summary(total: number, generatedAt: Instant): FieldSummary {
    const summary: FieldSummary = {
      missingValuePolicy: 'https://w3id.org/tss#ExcludeEmptyValues',
      count: this.count,
      missing: total - this.count,
    };
    if (this.first !== undefined) summary.firstTime = formatInstant(this.first);
    if (this.last !== undefined) summary.lastTime = formatInstant(this.last);
    if (this.numeric && this.numbers.length > 0) {
      summary.observedMinimum = this.min!.text;
      summary.observedMaximum = this.max!.text;
      const sum = this.numbers.reduce((a, b) => a + b, 0);
      summary.mean = numberToLexical(sum / this.numbers.length);
      const sorted = [...this.numbers].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      summary.median = numberToLexical(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
    }
    summary.generatedAtTime = formatInstant(generatedAt);
    return summary;
  }
}
