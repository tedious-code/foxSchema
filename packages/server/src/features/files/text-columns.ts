/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Working out where the columns are in a plain-text file, so the import form
 * can be filled in for the user instead of by them.
 *
 * Two shapes turn up, and they need different answers:
 *
 *  - **fixed width** — a report or mainframe extract, where a field occupies
 *    the same character range on every line. `detectFixedWidthColumns` finds
 *    the ranges by looking for character positions that are blank on *every*
 *    sampled line.
 *  - **delimited, but not CSV** — pipes, tabs, or runs of spaces, sometimes
 *    mixed in one file. `splitByDelimiters` handles those, including collapsing
 *    runs so `a   b` is two fields rather than four.
 *
 * Both are heuristics over a sample and both can be wrong, so both are meant to
 * *populate* the existing offsets UI, never to silently replace what the user
 * typed. Detection that cannot be corrected is worse than no detection.
 */

/**
 * Detection only ever needs the top of a file, so both are bounds on effort
 * rather than on what can be imported. They keep a large paste from turning
 * into server CPU.
 */
export const MAX_DETECT_LINES = 500;
export const MAX_DETECT_CHARS = 512 * 1024;

export interface DetectedColumn {
  name: string;
  /** 0-based, inclusive. */
  start: number;
  /** Character count. */
  length: number;
}

export interface DetectFixedWidthOptions {
  /**
   * Minimum run of all-blank positions that counts as a column gap.
   *
   * 1 is deliberate. A single space *inside* a value (`New York`) only looks
   * like a gap if it lands on the same column in every sampled line, which is
   * vanishingly unlikely once there are a few rows — whereas demanding 2 would
   * merge the many real reports that separate columns with one space. Raise it
   * if a specific file needs it.
   */
  minGap?: number;
  /**
   * A header line to take names from, sliced by the detected ranges. Usually
   * the last line skipped by `skipLines`. Without it, columns are `col_1…`.
   */
  headerLine?: string;
}

/** Space and tab both act as padding in fixed-width output. */
const isBlankChar = (ch: string | undefined): boolean =>
  ch === undefined || ch === ' ' || ch === '\t';

/**
 * Infer fixed-width column ranges from sample lines.
 *
 * A position is a gap only if it is blank on **every** line — one line with a
 * character there is enough to prove the position carries data. Lines shorter
 * than the widest are treated as blank past their end, which is what trailing
 * padding means.
 *
 * Returns `[]` when there is nothing to go on, rather than inventing a single
 * column: the caller should leave the form empty and let the user fill it in.
 */
export function detectFixedWidthColumns(
  lines: readonly string[],
  options: DetectFixedWidthOptions = {}
): DetectedColumn[] {
  const minGap = Math.max(1, options.minGap ?? 1);
  const sample = lines.filter((l) => l.trim().length > 0);
  if (sample.length === 0) return [];

  const width = sample.reduce((max, l) => Math.max(max, l.length), 0);
  if (width === 0) return [];

  // blank[i] — is position i padding on every sampled line?
  const blank: boolean[] = new Array<boolean>(width).fill(true);
  for (const line of sample) {
    for (let i = 0; i < width; i++) {
      if (blank[i] && !isBlankChar(line[i])) blank[i] = false;
    }
  }

  // Walk the blank map, cutting a column wherever a run of >= minGap blanks
  // separates data. Runs shorter than minGap stay *inside* the column.
  const ranges: Array<{ start: number; end: number }> = [];
  let start = -1;
  let blankRun = 0;
  for (let i = 0; i < width; i++) {
    if (blank[i]) {
      blankRun += 1;
      if (start >= 0 && blankRun >= minGap) {
        ranges.push({ start, end: i - blankRun + 1 });
        start = -1;
      }
      continue;
    }
    blankRun = 0;
    if (start < 0) start = i;
  }
  if (start >= 0) ranges.push({ start, end: width });

  return ranges.map((r, index) => ({
    name: headerName(options.headerLine, r.start, r.end, index),
    start: r.start,
    length: r.end - r.start,
  }));
}

/** Name from the header slice when it is usable, else a positional fallback. */
function headerName(
  headerLine: string | undefined,
  start: number,
  end: number,
  index: number
): string {
  const raw = headerLine?.slice(start, end).trim();
  return raw ? raw : `col_${index + 1}`;
}

export interface SplitOptions {
  /**
   * Treat a run of delimiters as one separator.
   *
   * On for whitespace-aligned text, where `a    b` is two fields. Off for
   * `a,,b`, where the empty middle field is real data. Getting this backwards
   * silently changes the column count, so it is explicit rather than guessed.
   */
  collapse?: boolean;
  /** Drop leading/trailing empties left by padding. Implied by `collapse`. */
  trimOuter?: boolean;
}

/**
 * Split a line on **any** of several delimiters.
 *
 * The CSV reader already handles one delimiter, including multi-character ones.
 * This is the other case: a file where more than one character separates
 * fields — pipes and tabs mixed, or a report using runs of spaces.
 *
 * Delimiters are matched longest-first, so passing `['||', '|']` does not let
 * the single pipe split a `||` into two empty fields.
 */
export function splitByDelimiters(
  line: string,
  delimiters: readonly string[],
  options: SplitOptions = {}
): string[] {
  const active = delimiters.filter((d) => d.length > 0);
  if (active.length === 0) return [line];
  const collapse = options.collapse ?? false;
  const trimOuter = options.trimOuter ?? collapse;

  // Longest first: otherwise '|' consumes the first half of '||'.
  const ordered = [...active].sort((a, b) => b.length - a.length);

  const fields: string[] = [];
  let field = '';
  let i = 0;
  let lastWasDelimiter = false;

  while (i < line.length) {
    const hit = ordered.find((d) => line.startsWith(d, i));
    if (hit === undefined) {
      field += line[i];
      i += 1;
      lastWasDelimiter = false;
      continue;
    }
    i += hit.length;
    if (collapse && lastWasDelimiter) continue; // run of separators — one break
    fields.push(field);
    field = '';
    lastWasDelimiter = true;
  }
  // A trailing delimiter under collapse has already produced its break.
  if (!(collapse && lastWasDelimiter)) fields.push(field);

  if (!trimOuter) return fields;
  while (fields.length > 0 && fields[0] === '') fields.shift();
  while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  return fields;
}

/**
 * Column ranges implied by splitting sample lines on delimiters.
 *
 * Lets a delimited file reuse the fixed-width offsets UI: detect, show the
 * ranges, let the user adjust. Width per column is the widest value seen, so
 * the preview does not clip.
 */
export function detectDelimitedColumns(
  lines: readonly string[],
  delimiters: readonly string[],
  options: SplitOptions & { headerLine?: string } = {}
): DetectedColumn[] {
  const sample = lines.filter((l) => l.trim().length > 0);
  if (sample.length === 0) return [];

  const widths: number[] = [];
  for (const line of sample) {
    splitByDelimiters(line, delimiters, options).forEach((value, i) => {
      widths[i] = Math.max(widths[i] ?? 0, value.trim().length);
    });
  }
  if (widths.length === 0) return [];

  const header = options.headerLine
    ? splitByDelimiters(options.headerLine, delimiters, options)
    : [];

  let cursor = 0;
  return widths.map((w, index) => {
    const length = Math.max(1, w);
    const column: DetectedColumn = {
      name: header[index]?.trim() || `col_${index + 1}`,
      start: cursor,
      length,
    };
    cursor += length + 1; // one notional separator between fields
    return column;
  });
}
