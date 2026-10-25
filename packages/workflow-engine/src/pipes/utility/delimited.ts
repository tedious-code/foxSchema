/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/delimited.ts).
 */
import * as z from 'zod';
import { escapeRegExp } from '@foxschema/sql';
import { REJECTS_PORT } from '../../sdk/index.js';
import { validateAgainstSchema } from '../../common/index.js';
import type { RecordBatch } from '../../registry/index.js';

/**
 * Pure delimited-text parsing shared by the CSV/Text source pipes and the
 * designer's preview endpoint — preview parses with exactly the code the run
 * will use, so what the designer shows is what the pipeline gets.
 */

export interface DelimitedLineOptions {
  /** Field delimiters — a value boundary is any one of them. */
  delimiters: string[];
  /**
   * Splits one line into several records before field splitting (flat map:
   * `a;1|b;2` with recordDelimiter `|` yields two records from one line).
   */
  recordDelimiter?: string;
  /** Positional field names; positions beyond the list get `field_N`. */
  fields?: string[];
  /** Trim whitespace around every value (default true). */
  trim?: boolean;
  /** Drop blank lines and blank record segments (default true). */
  skipEmpty?: boolean;
}

/**
 * Value types a column can declare. Text arrives as strings, so a declared
 * type is both a check and a conversion — downstream sinks receive real
 * numbers/booleans instead of `"42"` / `"true"`.
 */
export const COLUMN_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'date',
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/**
 * Suggested purposes for a column regex check. Free-form `kind` strings are
 * also accepted — these labels only shape failure messages.
 */
export const COLUMN_CHECK_KINDS = ['null', 'length', 'format'] as const;
export type ColumnCheckKind = (typeof COLUMN_CHECK_KINDS)[number];

/**
 * One regex check on a column's raw text. Use several to cover null tokens,
 * length bounds, and format in order — e.g. `^(?!(?:NULL|N/?A)$).+$`,
 * `^.{1,50}$`, `^\S+@\S+$`.
 */
export interface ColumnCheck {
  /** Regex the raw text must match. */
  pattern: string;
  /**
   * Purpose label shown in failures (`null`, `length`, `format`, or custom).
   * Does not change matching — only the error text.
   */
  kind?: string;
  /** Custom failure message; when set, replaces the default match text. */
  message?: string;
}

/** Per-column validation, independent of the whole-record JSON Schema. */
export interface ColumnRule {
  name: string;
  /** Declared value type; omitted (or `string`) leaves the text as-is. */
  type?: ColumnType;
  /**
   * Legacy single regex. Prefer {@link checks} when more than one rule is
   * needed; both are applied (legacy first) before type conversion.
   */
  pattern?: string;
  /**
   * Multiple regex checks — all must pass. Typical kinds: null / length /
   * format. Failures from every check are reported together.
   */
  checks?: ColumnCheck[];
  /** Reject empty values for this column. */
  required?: boolean;
}

/** Flatten legacy `pattern` + `checks` into the ordered list that runs. */
export function resolveColumnChecks(rule: ColumnRule): ColumnCheck[] {
  const checks: ColumnCheck[] = [];
  const seen = new Set<string>();
  const push = (check: ColumnCheck): void => {
    // Empty patterns are ignored so the designer can stage a new check row
    // before the user types the regex.
    const pattern = check.pattern?.trim();
    if (!pattern || seen.has(pattern)) return;
    seen.add(pattern);
    checks.push(check.pattern === pattern ? check : { ...check, pattern });
  };
  if (rule.pattern) push({ pattern: rule.pattern });
  if (rule.checks?.length) {
    for (const check of rule.checks) push(check);
  }
  return checks;
}

/**
 * One regex check in a column rule. Empty `pattern` is allowed in saved config
 * (designer staging) and stripped when the schema parses for preview/run.
 */
export const columnCheckSchema = z.object({
  pattern: z.string(),
  kind: z.string().optional(),
  message: z.string().optional(),
});

/** Checks array that drops blank staged rows after parse. */
export const columnChecksSchema = z
  .array(columnCheckSchema)
  .default([])
  .transform((checks) =>
    checks.filter((check) => check.pattern.trim().length > 0),
  );

/** Type / regex / required fields shared by fixed `columns` and delimited `rules`. */
export const columnRuleFieldsSchema = {
  type: z.enum(COLUMN_TYPES).optional(),
  pattern: z.string().min(1).optional(),
  checks: columnChecksSchema,
  required: z.boolean().optional(),
};

/** A column check with its pattern compiled once for the run. */
export interface CompiledColumnCheck {
  check: ColumnCheck;
  regex: RegExp;
}

/**
 * Compile every non-empty pattern for a rule set. Throws on malformed regex
 * so config errors surface at validate/save time, not mid-file.
 */
export function compileColumnRules(
  rules: ColumnRule[] | undefined,
): Map<string, CompiledColumnCheck[]> {
  const compiled = new Map<string, CompiledColumnCheck[]>();
  for (const rule of rules ?? []) {
    const checks: CompiledColumnCheck[] = [];
    for (const check of resolveColumnChecks(rule)) {
      try {
        checks.push({ check, regex: new RegExp(check.pattern) });
      } catch (error) {
        throw new Error(
          `column ${rule.name}: invalid pattern ${check.pattern}: ${(error as Error).message}`,
        );
      }
    }
    compiled.set(rule.name, checks);
  }
  return compiled;
}

/** One field of a fixed-width (positional) record. */
export interface FixedWidthColumn extends ColumnRule {
  /** 1-based character position where the field starts. */
  start: number;
  length: number;
}

/** Why one column of one record failed. */
export interface ColumnFailure {
  column: string;
  message: string;
}

const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'y', 't']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'n', 'f']);

/**
 * Apply per-column rules to one record: regex checks first (on the raw text),
 * then type conversion. Returns the converted record plus every failure —
 * all columns and all of a column's regex checks are evaluated, so one bad
 * row reports all of its problems at once.
 *
 * Pass `compiled` from {@link compileColumnRules} to avoid recompiling every
 * cell (and to fail fast on bad patterns before the first row). When omitted,
 * patterns are compiled on demand (tests / one-off preview helpers).
 *
 * Empty values are skipped unless `required`: a blank optional column is
 * absent data, not a type error.
 */
export function applyColumnRules(
  record: Record<string, unknown>,
  rules: ColumnRule[] | undefined,
  compiled?: Map<string, CompiledColumnCheck[]>,
): { record: Record<string, unknown>; failures: ColumnFailure[] } {
  if (!rules?.length) return { record, failures: [] };
  const converted: Record<string, unknown> = { ...record };
  const failures: ColumnFailure[] = [];
  const compiledByColumn = compiled ?? compileColumnRules(rules);

  for (const rule of rules) {
    const raw = record[rule.name];
    const text = raw === undefined || raw === null ? '' : String(raw);
    if (text === '') {
      if (rule.required) {
        failures.push({ column: rule.name, message: 'is required' });
      }
      continue;
    }
    const checks = compiledByColumn.get(rule.name) ?? [];
    let patternsOk = true;
    for (const { check, regex } of checks) {
      if (!regex.test(text)) {
        patternsOk = false;
        failures.push({
          column: rule.name,
          message: describeCheckFailure(text, check),
        });
      }
    }
    // Don't also report a type error for text the regexes already rejected.
    if (!patternsOk) continue;
    const result = convertValue(text, rule.type);
    if ('error' in result) {
      failures.push({ column: rule.name, message: result.error });
      continue;
    }
    converted[rule.name] = result.value;
  }
  return { record: converted, failures };
}

/** Human-readable failure for one regex check. */
function describeCheckFailure(text: string, check: ColumnCheck): string {
  if (check.message) return check.message;
  const label = check.kind?.trim();
  const matchText = `"${text}" does not match ${check.pattern}`;
  return label ? `${label}: ${matchText}` : matchText;
}

function convertValue(
  text: string,
  type: ColumnType | undefined,
): { value: unknown } | { error: string } {
  switch (type) {
    case undefined:
    case 'string':
      return { value: text };
    case 'integer': {
      if (!/^[+-]?\d+$/.test(text)) return { error: `"${text}" is not an integer` };
      const value = Number(text);
      return Number.isSafeInteger(value)
        ? { value }
        : { error: `"${text}" exceeds the safe integer range` };
    }
    case 'number': {
      const value = Number(text);
      return Number.isFinite(value)
        ? { value }
        : { error: `"${text}" is not a number` };
    }
    case 'boolean': {
      const normalized = text.trim().toLowerCase();
      if (BOOLEAN_TRUE.has(normalized)) return { value: true };
      if (BOOLEAN_FALSE.has(normalized)) return { value: false };
      return { error: `"${text}" is not a boolean` };
    }
    case 'date': {
      // Accepts ISO-ish text and the common compact YYYYMMDD flat-file form;
      // normalized to an ISO date string so sinks get a stable shape.
      const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
      const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : text;
      const parsed = new Date(iso);
      return Number.isNaN(parsed.getTime())
        ? { error: `"${text}" is not a date` }
        : { value: iso };
    }
  }
}

/** One human-readable line summarizing every column failure in a record. */
export function describeFailures(failures: ColumnFailure[]): string {
  return failures
    .map((failure) => `${failure.column} ${failure.message}`)
    .join('; ');
}

/**
 * How the first content line (after `offset`) is treated. Flat files from the
 * same feed often arrive with and without a header line — `auto` drops the
 * first line only when its values look like the configured column names.
 */
export type HeaderMode = 'none' | 'skip' | 'auto';

export interface TextParseOptions extends DelimitedLineOptions {
  /** Physical lines to skip from the top before parsing starts. */
  offset?: number;
  /** `delimited` splits on delimiters; `fixed` slices positional columns. */
  format?: 'delimited' | 'fixed';
  /** Column layout, required when `format` is `fixed`. */
  columns?: FixedWidthColumn[];
  /**
   * Per-field type/regex rules for `delimited` format (fixed-width carries
   * them on `columns`). Matched to fields by name.
   */
  rules?: ColumnRule[];
  header?: HeaderMode;
}

/** The per-column rules in effect, whichever format is configured. */
export function columnRules(
  options: TextParseOptions,
): ColumnRule[] | undefined {
  return options.format === 'fixed' ? options.columns : options.rules;
}

/** One record that failed column rules or the whole-record schema. */
export interface InvalidRecord {
  /** 0-based index into the parsed record list. */
  index: number;
  /**
   * 1-based physical line in the source text when known (text preview / parse).
   * Flat-mapped lines share the same `line` across several record indexes.
   */
  line?: number;
  message: string;
}

/** One regex that splits on any of the configured delimiters. */
export function fieldSplitter(delimiters: string[]): RegExp {
  if (delimiters.length === 0) throw new Error('at least one delimiter is required');
  // Longer delimiters first so "::" wins over ":" when both are configured.
  const alternatives = [...delimiters]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  return new RegExp(alternatives.join('|'));
}

/**
 * The splitter for a delimiter list, built once per list. `lineToRecords` runs
 * for every line of a file and the list is the parsed config's own array, so
 * this saves a sort, an escape and a `new RegExp` per line. The regex has no
 * `g` flag, so sharing one instance carries no `lastIndex` state between calls.
 */
const splitters = new WeakMap<string[], RegExp>();
function cachedSplitter(delimiters: string[]): RegExp {
  let splitter = splitters.get(delimiters);
  if (!splitter) splitters.set(delimiters, (splitter = fieldSplitter(delimiters)));
  return splitter;
}

/** Positional name for a value: the configured field, else `field_N` (1-based). */
export function fieldName(fields: string[] | undefined, index: number): string {
  return fields?.[index] ?? `field_${index + 1}`;
}

/**
 * Flat-map one line into records. Named fields missing from a segment are set
 * to `''` so a schema's `required`/`pattern` checks still see them.
 */
export function lineToRecords(
  line: string,
  options: DelimitedLineOptions,
): Record<string, string>[] {
  const { recordDelimiter, fields, trim = true, skipEmpty = true } = options;
  const splitter = cachedSplitter(options.delimiters);
  const segments = recordDelimiter ? line.split(recordDelimiter) : [line];
  const records: Record<string, string>[] = [];

  for (const segment of segments) {
    const text = trim ? segment.trim() : segment;
    if (skipEmpty && text.trim() === '') continue;
    const values = text.split(splitter).map((value) => (trim ? value.trim() : value));
    const record: Record<string, string> = {};
    for (let i = 0; i < Math.max(values.length, fields?.length ?? 0); i++) {
      record[fieldName(fields, i)] = values[i] ?? '';
    }
    records.push(record);
  }
  return records;
}

/** Slice one fixed-width line into a record (1-based column starts). */
export function sliceFixedLine(
  line: string,
  columns: FixedWidthColumn[],
  trim = true,
): Record<string, string> {
  if (columns.length === 0) throw new Error('at least one column is required');
  const record: Record<string, string> = {};
  for (const column of columns) {
    const value = line.slice(column.start - 1, column.start - 1 + column.length);
    record[column.name] = trim ? value.trim() : value;
  }
  return record;
}

/**
 * Does this first-line record look like a header? True when at least half of
 * its non-empty values name their own column (case-insensitive, trimmed) —
 * `ID   NAME   EMAIL` over columns id/name/email.
 *
 * A value counts as naming its column when it equals the name **or is a
 * prefix of it**: fixed-width headers are truncated to the column width
 * (`BIRTHDAT` in an 8-char birthdate field, `PR` for province), and real data
 * is essentially never a prefix of its own column name. The half-of-non-empty
 * threshold keeps a lucky single coincidence from dropping a data row.
 *
 * Deliberately name-based, not schema-based: a data row that merely fails
 * validation must surface as an error, never vanish as a presumed header.
 */
export function isHeaderRecord(
  record: Record<string, string>,
  names: string[],
): boolean {
  let nonEmpty = 0;
  let matches = 0;
  for (const name of names) {
    const value = record[name]?.trim().toLowerCase();
    if (!value) continue;
    nonEmpty++;
    if (name.trim().toLowerCase().startsWith(value)) matches++;
  }
  return nonEmpty > 0 && matches >= Math.max(1, Math.ceil(nonEmpty / 2));
}

/** Field names a text config produces, for header detection and previews. */
export function configuredNames(options: TextParseOptions): string[] {
  return options.format === 'fixed'
    ? (options.columns ?? []).map((column) => column.name)
    : (options.fields ?? []);
}

/** Parse one line by the configured format (fixed slice or delimited split). */
export function parseLine(
  line: string,
  options: TextParseOptions,
): Record<string, string>[] {
  if (options.format === 'fixed') {
    if (!options.columns?.length) {
      throw new Error('fixed format requires at least one column');
    }
    return [sliceFixedLine(line, options.columns, options.trim ?? true)];
  }
  return lineToRecords(line, options);
}

/** One record a text line produced, and what the column rules made of it. */
export interface TextRow {
  /** The values as split, before any rule converted them. */
  raw: Record<string, string>;
  record: Record<string, unknown>;
  /** Why a column rule refused it, or null. */
  failure: string | null;
  /** 1-based line it came from. */
  line: number;
}

/**
 * Text records, line by line: offset, empty lines, the header, the flat map
 * and the column rules — the one reading the run and the designer preview
 * share, so the preview shows what a run will read. `push` takes the next
 * line and returns the records it produced (none for a skipped line).
 */
export class TextRowReader {
  private lineNumber = 0;
  private headerDone: boolean;
  private readonly rules: ReturnType<typeof columnRules>;
  private readonly compiled: ReturnType<typeof compileColumnRules>;

  /** `resumeAfter`: lines a checkpoint already covers, which also puts the header behind it. */
  constructor(
    private readonly options: TextParseOptions,
    private readonly resumeAfter = 0,
  ) {
    this.headerDone = (options.header ?? 'none') === 'none' || resumeAfter > 0;
    this.rules = columnRules(options);
    this.compiled = compileColumnRules(this.rules);
  }

  /** The last line number pushed. */
  get line(): number {
    return this.lineNumber;
  }

  push(text: string): TextRow[] {
    this.lineNumber++;
    const { offset = 0, skipEmpty = true, header = 'none' } = this.options;
    if (this.lineNumber <= offset || this.lineNumber <= this.resumeAfter) return [];
    if (skipEmpty && text.trim() === '') return [];
    const parsed = parseLine(text, this.options);
    if (!this.headerDone) {
      this.headerDone = true;
      if (header === 'skip') return [];
      // auto: drop only when the line names its own columns.
      if (parsed[0] && isHeaderRecord(parsed[0], configuredNames(this.options))) return [];
    }
    return parsed.map((raw) => {
      const applied = applyColumnRules(raw, this.rules, this.compiled);
      return {
        raw,
        record: applied.record,
        failure: applied.failures.length > 0 ? describeFailures(applied.failures) : null,
        line: this.lineNumber,
      };
    });
  }
}

/**
 * Parse a whole text block and apply per-column rules, reporting both the
 * converted records and every column failure by record index — the preview
 * path, read by the same {@link TextRowReader} as a run.
 *
 * `lines[i]` is the 1-based source line for `records[i]`, so schema failures
 * (which only know the record index) can still report which row failed.
 */
export function parseTextRows(
  text: string,
  options: TextParseOptions,
): {
  records: Record<string, unknown>[];
  invalid: InvalidRecord[];
  lines: number[];
} {
  // Lines as the run reads them (`readLines`): split on `\n`, a trailing `\r`
  // dropped, no line after a final newline. Splitting on a bare `\r` too made
  // a classic-Mac file preview as many rows and then run as one.
  const sourceLines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  if (sourceLines[sourceLines.length - 1] === '') sourceLines.pop();
  const reader = new TextRowReader(options);
  const records: Record<string, unknown>[] = [];
  const invalid: InvalidRecord[] = [];
  const lines: number[] = [];
  for (const line of sourceLines) {
    for (const row of reader.push(line)) {
      if (row.failure !== null) invalid.push({ index: records.length, line: row.line, message: row.failure });
      records.push(row.record);
      lines.push(row.line);
    }
  }
  return { records, invalid, lines };
}

/** Parse a whole text block: split lines, apply the offset, flat-map records. */
export function parseTextRecords(
  text: string,
  options: TextParseOptions,
): Record<string, unknown>[] {
  return parseTextRows(text, options).records;
}

/**
 * Dead-letter batch for the `rejects` output port. Deliberately cursor-less:
 * a source's checkpoint may only advance when every record up to that
 * position has been emitted as data, so reject batches never move the cursor.
 * After a crash-resume some rejects can re-emit — their ids are stable
 * (`pipe:rejects:first-last`), so idempotent sinks deduplicate them.
 */
export function rejectBatch(
  pipeId: string,
  first: number,
  last: number,
  records: Record<string, unknown>[],
): RecordBatch {
  return {
    id: `${pipeId}:rejects:${first}-${last}`,
    partitionId: '0',
    records,
    port: REJECTS_PORT,
  };
}

/** How a source names a position in its errors and on rejected rows. */
export interface EmitterPositions {
  /** Checkpoint cursor key: `row`, `line`, `index`. */
  cursorKey: string;
  /** Key the position is stored under on a rejected row: `_row`, `_line`, `_index`. */
  positionKey: string;
  /** How an error names the position: `CSV row`, `line`, `index`. */
  label: string;
  /**
   * `record` cuts a batch the moment it is full. `boundary` cuts only in
   * {@link BatchEmitter.drain}: a text line can flat-map to several records
   * and its cursor is the line, so a line must never straddle two batches.
   */
  cut: 'record' | 'boundary';
}

/** Why a record was refused before it reached the data stream. */
export type RecordFailure = { reason: 'to parse' | 'validation' | 'schema'; message: string };

/**
 * The batching every file source shares: applies `onInvalid` to records that
 * failed, cuts data batches (with a cursor) and reject batches (cursor-less,
 * on the `rejects` port) at `batchSize`, and flushes rejects before the final
 * data batch so the run's last checkpoint covers everything emitted.
 *
 * CSV, text and JSON each kept their own copy of this, and the copies had
 * drifted — where they cut, what the last cursor named, how errors read.
 */
export class BatchEmitter {
  private records: Record<string, unknown>[] = [];
  private first = 0;
  private last = 0;
  private rejects: Record<string, unknown>[] = [];
  private firstReject = 0;
  private lastReject = 0;
  private pending: RecordBatch[] = [];

  constructor(
    private readonly pipeId: string,
    private readonly config: {
      batchSize: number;
      onInvalid: 'fail' | 'skip' | 'reject';
      schema?: Record<string, unknown>;
    },
    private readonly positions: EmitterPositions,
  ) {}

  /**
   * One record at `position`. `failure` is set when it already failed (did not
   * parse, a column rule refused it); otherwise the schema, if any, decides.
   * A rejected record is stored as `rejectAs` (the raw values, say) when given.
   */
  add(
    record: Record<string, unknown>,
    position: number,
    failure: RecordFailure | null = null,
    rejectAs: Record<string, unknown> = record,
  ): void {
    const schemaMessage = failure === null && this.config.schema ? validateAgainstSchema(this.config.schema, record) : null;
    const refused = failure ?? (schemaMessage === null ? null : { reason: 'schema' as const, message: schemaMessage });
    if (refused !== null) {
      if (this.config.onInvalid === 'fail') {
        throw new Error(`${this.positions.label} ${position} failed ${refused.reason}: ${refused.message}`);
      }
      if (this.config.onInvalid === 'reject') {
        if (this.rejects.length === 0) this.firstReject = position;
        this.lastReject = position;
        this.rejects.push({ ...rejectAs, _error: refused.message, [this.positions.positionKey]: position });
        if (this.positions.cut === 'record' && this.rejects.length === this.config.batchSize) this.cutRejects();
      }
      return; // skip and reject both leave the data stream
    }
    if (this.records.length === 0) this.first = position;
    this.last = position;
    this.records.push(record);
    if (this.positions.cut === 'record' && this.records.length === this.config.batchSize) this.cutData(this.last);
  }

  /** Batches that are ready. In `boundary` mode, call at each boundary: this is where they are cut. */
  *drain(): Iterable<RecordBatch> {
    if (this.positions.cut === 'boundary') {
      if (this.rejects.length >= this.config.batchSize) this.cutRejects();
      if (this.records.length >= this.config.batchSize) this.cutData(this.last);
    }
    yield* this.pending.splice(0);
  }

  /**
   * Everything left: rejects first, then the final data batch. Its cursor is
   * `lastPosition` — the last position read — when given, so rows after the
   * last good one that were skipped or rejected are not read again on resume.
   */
  *flush(lastPosition?: number): Iterable<RecordBatch> {
    yield* this.pending.splice(0);
    if (this.rejects.length > 0) this.cutRejects();
    yield* this.pending.splice(0);
    if (this.records.length > 0) {
      yield this.dataBatch(Math.max(this.last, lastPosition ?? this.last));
      this.records = [];
    }
  }

  private cutRejects(): void {
    this.pending.push(rejectBatch(this.pipeId, this.firstReject, this.lastReject, this.rejects));
    this.rejects = [];
  }

  private cutData(end: number): void {
    this.pending.push(this.dataBatch(end));
    this.records = [];
  }

  private dataBatch(end: number): RecordBatch {
    return {
      id: `${this.pipeId}:0:${this.first}-${end}`,
      partitionId: '0',
      records: this.records,
      cursor: { [this.positions.cursorKey]: end },
    };
  }
}

/**
 * Validate records against a JSON Schema (the designer authors it as Zod;
 * regex rules arrive as `pattern`). Returns the failures, not a filtered list —
 * callers decide whether invalid records fail the run, get skipped, or get
 * highlighted in a preview.
 */
export function invalidRecords(
  records: Record<string, unknown>[],
  schema: Record<string, unknown> | undefined,
): InvalidRecord[] {
  if (!schema) return [];
  const invalid: InvalidRecord[] = [];
  for (const [index, record] of records.entries()) {
    const message = validateAgainstSchema(schema, record);
    if (message !== null) invalid.push({ index, message });
  }
  return invalid;
}
