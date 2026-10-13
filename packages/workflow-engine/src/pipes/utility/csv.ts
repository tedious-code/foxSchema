/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/csv.ts).
 */
import { createReadStream } from 'node:fs';
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
import { validateAgainstSchema } from '../../common/index.js';
import { rejectBatch } from './delimited.js';
import { resolveWorkflowFile } from './file-root.js';

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
    let skipped = 0;
    let headers: string[] | undefined;
    let rowNumber = 0;
    let records: Record<string, unknown>[] = [];
    let firstRow = 0;
    let rejects: Record<string, unknown>[] = [];
    let firstReject = 0;
    let lastReject = 0;

    for await (const values of parseCsv(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the source file path is this pipe's own configuration, confined to the files root
      createReadStream(await resolveWorkflowFile(config.path), { encoding: 'utf8' }),
      config.delimiter,
    )) {
      if (skipped < config.skipLines) {
        skipped++;
        continue;
      }
      if (!headers) {
        headers = deriveHeaders(values);
        continue;
      }
      rowNumber++;
      if (rowNumber <= resumeAfter) continue;
      const record = Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? '']),
      );
      if (config.schema) {
        const message = validateAgainstSchema(config.schema, record);
        if (message !== null) {
          if (config.onInvalid === 'fail') {
            throw new Error(`CSV row ${rowNumber} failed schema: ${message}`);
          }
          if (config.onInvalid === 'reject') {
            if (rejects.length === 0) firstReject = rowNumber;
            lastReject = rowNumber;
            rejects.push({ ...record, _error: message, _row: rowNumber });
            if (rejects.length === config.batchSize) {
              yield rejectBatch(context.pipe.id, firstReject, lastReject, rejects);
              rejects = [];
            }
          }
          continue; // skip/reject — the row leaves the data stream either way
        }
      }
      if (records.length === 0) firstRow = rowNumber;
      records.push(record);
      if (records.length === config.batchSize) {
        yield makeBatch(context.pipe.id, firstRow, rowNumber, records);
        records = [];
      }
    }
    // Rejects flush before the final data batch so the run's last checkpoint
    // (data cursors only) still covers everything that was emitted.
    if (rejects.length > 0) {
      yield rejectBatch(context.pipe.id, firstReject, lastReject, rejects);
    }
    if (records.length > 0) {
      yield makeBatch(context.pipe.id, firstRow, rowNumber, records);
    }
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
 * Parse a full CSV text block into records — the preview path. Shares
 * `parseCsv`/`deriveHeaders` with the streaming pipe so preview and run agree.
 */
export async function parseCsvRecords(
  text: string,
  options: { delimiter?: string; skipLines?: number } = {},
): Promise<{ headers: string[]; records: Record<string, string>[] }> {
  const { delimiter = ',', skipLines = 0 } = options;
  let skipped = 0;
  let headers: string[] | undefined;
  const records: Record<string, string>[] = [];
  for await (const values of parseCsv([text], delimiter)) {
    if (skipped < skipLines) {
      skipped++;
      continue;
    }
    if (!headers) {
      headers = deriveHeaders(values);
      continue;
    }
    records.push(
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
    );
  }
  return { headers: headers ?? [], records };
}

function makeBatch(
  pipeId: string,
  firstRow: number,
  lastRow: number,
  records: Record<string, unknown>[],
): RecordBatch {
  return {
    id: `${pipeId}:0:${firstRow}-${lastRow}`,
    partitionId: '0',
    records,
    cursor: { row: lastRow },
  };
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
): AsyncIterable<string[]> {
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;

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
        if (close === -1) {
          field += text.slice(at);
          break;
        }
        field += text.slice(at, close);
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
        yield row;
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
    yield row;
  }
}
