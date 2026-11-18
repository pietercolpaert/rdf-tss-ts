/** Exact decimal arithmetic, enough for `tss:DeltaFromBaseline` and for exact summaries. */

const DECIMAL_RE = /^([+-])?(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/;

export class Decimal {
  /** The value is `int / 10^scale`. */
  constructor(
    readonly int: bigint,
    readonly scale: number,
  ) {}

  static parse(text: string): Decimal | null {
    const m = DECIMAL_RE.exec(text.trim());
    if (!m) return null;
    const [whole, fraction = ''] = m[2].split('.');
    let scale = fraction.length - Number(m[3] ?? 0);
    let int = BigInt((whole || '0') + fraction);
    if (scale < 0) {
      int *= 10n ** BigInt(-scale);
      scale = 0;
    }
    return new Decimal(m[1] === '-' ? -int : int, scale);
  }

  add(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale);
    const a = this.int * 10n ** BigInt(scale - this.scale);
    const b = other.int * 10n ** BigInt(scale - other.scale);
    return new Decimal(a + b, scale);
  }

  toString(): string {
    const negative = this.int < 0n;
    const digits = (negative ? -this.int : this.int).toString().padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const fraction = digits.slice(digits.length - this.scale);
    return (negative ? '-' : '') + whole + (fraction ? '.' + fraction : '');
  }

  toNumber(): number {
    return Number(this.toString());
  }
}
