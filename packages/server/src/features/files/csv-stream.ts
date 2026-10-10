/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Incremental CSV reader: feed it decoded text a chunk at a time, take rows out
 * as they complete. Nothing here holds the file, so the caller can read a 1 GB
 * upload through a stream and flush batches to the database instead of building
 * a matrix the heap cannot hold.
 *
 * The grammar is deliberately identical to `parseCsv` in files/file-query.service.ts,
 * character for character — same BOM strip, same `""` unescaping, same
 * multi-character delimiter, same "\r is skipped everywhere", same rule that a
 * lone trailing newline does not produce a row. A streaming reader that parsed
 * *almost* the same would import subtly different data depending on file size,
 * which is worse than not having one.
 *
 * What it cannot do, and why the buffered path still exists: column naming for
 * a headerless file needs the widest row, and type inference reads a whole
 * column. Both need the last row before they can answer, so a streaming caller
 * has to decide those from a sample instead. That is a behaviour change, not a
 * refactor, so it is left to the caller rather than assumed here.
 */

export interface CsvStreamOptions {
  delimiter?: string;
  /** Rows to buffer before {@link CsvStreamReader.take} returns them. */
  batchSize?: number;
}

const DEFAULT_BATCH = 1000;

export class CsvStreamReader {
  private readonly delimiter: string;
  private readonly dLen: number;
  private readonly batchSize: number;

  /** Parser state, carried across chunk boundaries. */
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  /** A quote seen at the very end of a chunk: `""` or a close, not yet known. */
  private pendingQuote = false;
  /** Tail too short to rule out a multi-character delimiter starting in it. */
  private carry = '';
  private atStart = true;

  private rows: string[][] = [];
  private rowCount = 0;

  constructor(options: CsvStreamOptions = {}) {
    this.delimiter = options.delimiter ?? ',';
    this.dLen = this.delimiter.length;
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
  }

  /** Total rows emitted so far (excludes any still buffered). */
  get emitted(): number {
    return this.rowCount;
  }

  private pushField(): void {
    this.row.push(this.field);
    this.field = '';
  }

  private pushRow(): void {
    // Matches parseCsv: a trailing newline at end of file must not add a row,
    // but a genuinely blank line between records still counts.
    if (this.row.length === 1 && this.row[0] === '' && this.rowCount > 0) {
      this.row = [];
      return;
    }
    this.rows.push(this.row);
    this.rowCount += 1;
    this.row = [];
  }

  /**
   * Feed decoded text. The caller must decode bytes with a StringDecoder (or
   * equivalent) so a multi-byte character is never split across calls — this
   * reader works in characters, not bytes.
   */
  write(chunk: string): void {
    let text = this.carry + chunk;
    this.carry = '';

    if (this.atStart) {
      text = text.replace(/^﻿/, '');
      this.atStart = false;
    }

    // With a multi-character delimiter, stop as soon as one starting here could
    // not be examined in full, and carry the rest into the next chunk.
    //
    // The stop point has to come from where the loop actually ended, not from a
    // slice taken up front: a delimiter match consumes dLen characters and can
    // legitimately run past a precomputed boundary, and carrying the tail
    // anyway replayed its second half as literal text. `a||b||c` fed one
    // character at a time came out as `a`, `|b`, `|c`.
    //
    // Deferring is always safe — held-back characters are simply parsed on the
    // next pass, in whatever state applies then — so this does not need to care
    // whether we are inside quotes.
    const holdback = this.dLen > 1;
    let i = 0;
    for (; i < text.length; i++) {
      if (holdback && i + this.dLen > text.length) break;
      const ch = text[i]!;

      if (this.pendingQuote) {
        // Resolve a quote that ended the previous chunk.
        this.pendingQuote = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
        // fall through and handle `ch` as an unquoted character
      }

      if (this.inQuotes) {
        if (ch === '"') {
          if (i + 1 < text.length) {
            if (text[i + 1] === '"') {
              this.field += '"';
              i++;
            } else {
              this.inQuotes = false;
            }
          } else {
            // Last character available: cannot tell `""` from a close yet.
            this.pendingQuote = true;
          }
        } else {
          this.field += ch;
        }
        continue;
      }

      if (ch === '"') {
        this.inQuotes = true;
        continue;
      }
      if (this.dLen > 0 && text.startsWith(this.delimiter, i)) {
        this.pushField();
        i += this.dLen - 1;
        continue;
      }
      if (ch === '\n') {
        this.pushField();
        this.pushRow();
        continue;
      }
      if (ch === '\r') continue;
      this.field += ch;
    }
    this.carry = text.slice(i);
  }

  /** Flush the final field/row. Call once, after the last {@link write}. */
  end(): void {
    if (this.carry) {
      const tail = this.carry;
      this.carry = '';
      // No more input can arrive, so the held-back tail is final: replay it
      // through the same grammar with the hold-back skipped.
      this.writeTailVerbatim(tail);
    }
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.field.length > 0 || this.row.length > 0) {
      this.pushField();
      this.pushRow();
    }
  }

  /** Same loop as {@link write} but with no hold-back — end-of-input only. */
  private writeTailVerbatim(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
      }
      if (this.inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            this.field += '"';
            i++;
          } else {
            this.inQuotes = false;
          }
        } else {
          this.field += ch;
        }
        continue;
      }
      if (ch === '"') {
        this.inQuotes = true;
        continue;
      }
      if (this.dLen > 0 && text.startsWith(this.delimiter, i)) {
        this.pushField();
        i += this.dLen - 1;
        continue;
      }
      if (ch === '\n') {
        this.pushField();
        this.pushRow();
        continue;
      }
      if (ch === '\r') continue;
      this.field += ch;
    }
  }

  /** True once a full batch is ready. */
  get hasBatch(): boolean {
    return this.rows.length >= this.batchSize;
  }

  /** Remove and return the buffered rows. */
  take(): string[][] {
    const out = this.rows;
    this.rows = [];
    return out;
  }
}
