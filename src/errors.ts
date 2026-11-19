/** One finding of a validation: which rule failed and where. */
export interface ReportEntry {
  /** Short identifier of the rule, e.g. `time-field` or `lexical-form`. */
  rule: string;
  message: string;
  /** IRI or label of the node (source, field) the finding is about. */
  node?: string;
  /** 1-based row of the data (embedded point or file row) the finding is about. */
  row?: number;
}

/** The result of `validate()`: every rule that fails and where. */
export interface Report {
  conforms: boolean;
  results: ReportEntry[];
}

/** The metadata or data does not conform to the specification. */
export class ValidationError extends Error {
  readonly report: Report;
  constructor(message: string, report?: Report) {
    super(message);
    this.name = 'ValidationError';
    this.report = report ?? { conforms: false, results: [{ rule: 'general', message }] };
  }
}

/** Writing to an immutable source, or to one whose class cannot be appended to. */
export class NotWritableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotWritableError';
  }
}

/** Another process is writing to the source. */
export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

/** No unit, unknown unit, or units of different dimensions. */
export class UnitConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitConversionError';
  }
}

export function makeReport(results: ReportEntry[]): Report {
  return { conforms: results.length === 0, results };
}
