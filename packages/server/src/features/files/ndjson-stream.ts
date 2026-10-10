/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Incremental NDJSON reader — the JSON counterpart to CsvStreamReader. Feed it
 * decoded text a chunk at a time, take records out as whole lines complete.
 * Memory tracks the batch, not the file.
 *
 * Why this and not a JSON streaming library: NDJSON is one JSON value per
 * line, so the only thing that needs streaming is the line splitting, and
 * `JSON.parse` on a single record is already the fastest correct parser
 * available. A dependency would buy nothing here and add supply-chain surface
 * that CI scans on every build.
 *
 * Array-mode JSON (`[{…},{…}]`) is a different problem — a single value
 * spanning the whole file, which genuinely needs an incremental JSON parser to
 * stream. That is not solved here, deliberately; see the review notes on
 * stream-json.
 *
 * The grammar matches `parseJsonRecords` in ndjson mode exactly: same
 * blank-line skipping, same "each line must be a JSON object" rule, same
 * 1-based line numbers in errors. A streaming reader that diverged would
 * import different data — or accept different files — depending on size.
 *
 * There is deliberately no explicit byte-order-mark strip: every line is
 * trimmed, and `String.prototype.trim()` treats U+FEFF as whitespace. An
 * earlier version stripped it separately; removing that code changed no test,
 * with no callers at present.
 */
import { errorMessage } from '@foxschema/sql';

export interface NdjsonStreamOptions {
  /** Records to buffer before {@link NdjsonStreamReader.take} returns them. */
  batchSize?: number;
}

const DEFAULT_BATCH = 1000;

export class NdjsonStreamReader {
  private readonly batchSize: number;

  private carry = '';
  /** 1-based, counts every physical line including blanks, to match errors. */
  private lineNo = 0;

  private records: Record<string, unknown>[] = [];
  private recordCount = 0;

  constructor(options: NdjsonStreamOptions = {}) {
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  }

  /** Records emitted so far (excludes any still buffered). */
  get emitted(): number {
    return this.recordCount;
  }

  private pushLine(raw: string): void {
    this.lineNo += 1;
    // trim() also removes a leading U+FEFF, so this covers the byte-order mark
    // without a separate strip — and it does so on every line, which is what
    // the buffered path's `.map(l => l.trim())` does too.
    const line = raw.trim();
    if (!line) return; // blank lines are skipped, exactly as the buffered path does
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause: unknown) {
      // Name the line. A parse failure 400,000 records into a file is useless
      // without one, and the buffered path numbers them too.
      throw new Error(
        `NDJSON line ${this.lineNo} is not valid JSON: ${
          errorMessage(cause)
        }`
      );
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`NDJSON line ${this.lineNo} must be a JSON object`);
    }
    this.records.push(value as Record<string, unknown>);
    this.recordCount += 1;
  }

  /**
   * Feed decoded text. The caller must decode bytes with a StringDecoder (or
   * equivalent) so a multi-byte character is never split across calls.
   */
  write(chunk: string): void {
    const text = this.carry + chunk;
    this.carry = '';

    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '\n') continue;
      // Slice excludes the \n; a trailing \r is removed by trim() in pushLine,
      // which is also how the buffered split(/\r?\n/) behaves.
      this.pushLine(text.slice(start, i));
      start = i + 1;
    }
    // Whatever follows the last newline may be a partial record.
    this.carry = text.slice(start);
  }

  /** Flush the final line. Call once, after the last {@link write}. */
  end(): void {
    const tail = this.carry;
    this.carry = '';
    if (tail.length > 0) this.pushLine(tail);
  }

  /** True once a full batch is ready. */
  get hasBatch(): boolean {
    return this.records.length >= this.batchSize;
  }

  /** Remove and return the buffered records. */
  take(): Record<string, unknown>[] {
    const out = this.records;
    this.records = [];
    return out;
  }
}

/**
 * Union of keys across records, in first-seen order.
 *
 * Streaming cannot know the full column set before the last record, so a
 * caller that must fix columns early has to take them from a sample and decide
 * what to do with keys that appear later. Kept here so that choice is explicit
 * at the call site rather than buried in the reader.
 */
export function collectColumns(
  records: readonly Record<string, unknown>[],
  into: string[] = []
): string[] {
  const seen = new Set(into);
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      into.push(key);
    }
  }
  return into;
}
