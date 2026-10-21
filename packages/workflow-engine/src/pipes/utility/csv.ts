/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/csv.ts).
 */
import * as z from 'zod';
import type {
  PipeContext,
  RecordBatch,
  SourcePipe,
} from '../../registry/index.js';
import {
  REJECTS_PORT,
  batchSizeField,
  definePipeMetadata,
  recordContractFields,
  rejectPolicyField,
  type PipeMetadata,
} from '../../sdk/index.js';
import { BatchEmitter } from './delimited.js';
import { openWorkflowFile } from './workflow-files.js';

/** Exported so the preview endpoint parses with the pipe's own field shape. */
export const csvConfigFields = z.object({
  path: z.string().min(1),
  delimiter: z.string().length(1).default(','),
  // Rows to skip before the header row (report preambles, title lines).
  skipLines: z.number().int().min(0).default(0),
  ...batchSizeField(),
  ...recordContractFields,
  ...rejectPolicyField,
});

export class CsvSourcePipe implements SourcePipe {
  readonly type = 'source.file.csv';
  readonly role = 'source';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'CSV file',
      category: 'Source/File',
      family: 'file',
      version: '0.3.0',
      role: 'source',
      inputs: [],
      outputs: [
        { name: 'out', type: 'records' },
        // Dead-letter: schema-invalid rows when onInvalid is 'reject'.
        { name: REJECTS_PORT, type: 'records' },
      ],
      configSchema: csvConfigFields,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    csvConfigFields.parse(config);
  }

  async *read(context: PipeContext): AsyncIterable<RecordBatch> {
    const config = csvConfigFields.parse(context.pipe.config);
    const resumeAfter = Number(context.checkpoint?.cursor.row ?? 0);
    const emitter = new BatchEmitter(context.pipe.id, config, {
      cursorKey: 'row',
      positionKey: '_row',
      label: 'CSV row',
      cut: 'record',
    });
    let rowNumber = 0;
    for await (const { record, row } of csvRows((await openWorkflowFile(config.path)).readStream(), config)) {
      rowNumber = row;
      if (row <= resumeAfter) continue;
      emitter.add(record, row);
      yield* emitter.drain();
    }
    yield* emitter.flush(rowNumber);
  }
}

/** Header row → column names: BOM-stripped, non-empty, unique. */
export function deriveHeaders(values: string[]): string[] {
  const headers = values.map((value, index) => {
    const header = index === 0 ? value.replace(/^\uFEFF/, '') : value;
    if (!header) throw new Error('CSV headers must not be empty');
    return header;
  });
  if (new Set(headers).size !== headers.length) {
    throw new Error('CSV headers must be unique');
  }
  return headers;
}

/**
 * Parse a full CSV text block into records — the preview path, through the
 * same {@link csvRows} the run reads with. `lines` is where each record
 * starts in the text.
 */
export async function parseCsvRecords(
  text: string,
  options: { delimiter?: string; skipLines?: number } = {},
): Promise<{ headers: string[]; records: Record<string, string>[]; lines: number[] }> {
  let headers: string[] = [];
  const records: Record<string, string>[] = [];
  const lines: number[] = [];
  const rows = csvRows([text], { delimiter: options.delimiter ?? ',', skipLines: options.skipLines ?? 0 }, (found) => {
    headers = found;
  });
  for await (const { record, line } of rows) {
    records.push(record);
    lines.push(line);
  }
  return { headers, records, lines };
}

/**
 * CSV rows from text chunks: RFC 4180 quoting (`""` inside quotes is a quote),
 * `\n` rows with a trailing `\r` dropped, a quote special only at a field's
 * start. State carries across chunks, so a quote or `\r\n` may straddle one.
 *
 * Scans with `indexOf` and takes fields with `slice`: walking every character
 * and growing each field one at a time cost a loop turn and a string copy
 * per byte on every CSV run.
 */
export async function* parseCsv(
  chunks: AsyncIterable<string | Buffer> | Iterable<string>,
  delimiter: string,
): AsyncIterable<{ values: string[]; line: number }> {
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;
  // Physical lines: every `\n` read, inside quotes too, so a row's `line` is
  // where it starts in the file even after a multi-line quoted field.
  let newlines = 0;
  let rowStart = 1;

  for await (const chunk of chunks) {
    const text = String(chunk);
    const length = text.length;
    let at = 0;
    while (at < length) {
      if (pendingQuote) {
        pendingQuote = false;
        if (text[at] === '"') {
          // `""` inside a quoted field: one literal quote, still quoted.
          field += '"';
          at++;
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        const close = text.indexOf('"', at);
        const end = close === -1 ? length : close;
        newlines += countNewlines(text, at, end);
        field += text.slice(at, end);
        if (close === -1) break;
        pendingQuote = true;
        at = close + 1;
        continue;
      }
      const char = text[at];
      if (char === '"' && field.length === 0) {
        quoted = true;
        at++;
      } else if (char === delimiter) {
        row.push(field);
        field = '';
        at++;
      } else if (char === '\n') {
        row.push(field.replace(/\r$/, ''));
        newlines++;
        yield { values: row, line: rowStart };
        rowStart = newlines + 1;
        field = '';
        row = [];
        at++;
      } else {
        // Plain text up to the next delimiter or newline. The field is not
        // empty once this char is in it, so a quote inside the run is literal.
        const nextDelimiter = text.indexOf(delimiter, at + 1);
        const nextNewline = text.indexOf('\n', at + 1);
        let end = length;
        if (nextDelimiter !== -1) end = nextDelimiter;
        if (nextNewline !== -1 && nextNewline < end) end = nextNewline;
        field += text.slice(at, end);
        at = end;
      }
    }
  }
  if (quoted && !pendingQuote) throw new Error('unterminated quoted CSV field');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    yield { values: row, line: rowStart };
  }
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let at = text.indexOf('\n', from); at !== -1 && at < to; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/** One CSV record: its 1-based ordinal after the header, and the physical line it starts on. */
export interface CsvRow {
  record: Record<string, string>;
  row: number;
  line: number;
}

/**
 * The records a CSV source reads, after its preamble and header — the one
 * reading the run and the designer preview share, so they cannot disagree on
 * which row is which. `onHeaders` hears the column names even when no record
 * follows them.
 */
export async function* csvRows(
  chunks: AsyncIterable<string | Buffer> | Iterable<string>,
  options: { delimiter: string; skipLines: number },
  onHeaders?: (headers: string[]) => void,
): AsyncIterable<CsvRow> {
  let skipped = 0;
  let headers: string[] | undefined;
  let row = 0;
  for await (const { values, line } of parseCsv(chunks, options.delimiter)) {
    if (skipped < options.skipLines) {
      skipped++;
      continue;
    }
    if (!headers) {
      headers = deriveHeaders(values);
      onHeaders?.(headers);
      continue;
    }
    row++;
    const record: Record<string, string> = {};
    for (let index = 0; index < headers.length; index++) record[headers[index]!] = values[index] ?? '';
    yield { record, row, line };
  }
}
