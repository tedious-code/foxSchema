/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/file-sink.ts).
 */
import { z } from 'zod';
import type { PipeContext, RecordBatch, SinkPipe } from '../../registry/index.js';
import { definePipeMetadata, type PipeMetadata } from '../../sdk/index.js';
import { openWorkflowFile } from './workflow-files.js';

/**
 * Write records to a delimited file.
 *
 * FoxAgent could read CSV and never write it, which is a strange gap the moment
 * the user is a team that lives in spreadsheets: they can feed a workflow from
 * an export, but the result has nowhere to land except a database, an HTTP
 * endpoint, or an email. This is the other half.
 *
 * `append` is the default because the shape of the job is usually daily: one
 * file per week or per campaign that grows a few rows at a time and gets opened
 * in Excel at the end. Overwriting by default would silently destroy yesterday
 * on the first scheduled run.
 */

const configSchema = z.object({
  path: z.string().min(1),
  /**
   * Column order, explicit. Deriving it from the first record would make the
   * file's shape depend on which row happened to arrive first, and a
   * spreadsheet whose columns move between runs is worse than no file.
   */
  columns: z.array(z.string().min(1)).min(1),
  delimiter: z.string().min(1).max(4).default(','),
  /** Written once, when the file is created — never in the middle. */
  header: z.boolean().default(true),
  mode: z.enum(['append', 'overwrite']).default('append'),
  /** Line ending. CRLF is what Excel on Windows expects. */
  newline: z.enum(['\n', '\r\n']).default('\n'),
  /**
   * Prefix `'` to text a spreadsheet would run as a formula. On by default:
   * values come from source rows anyone may have typed. Turn off only for a
   * file no spreadsheet will open.
   */
  escapeFormulas: z.boolean().default(true),
});

export type FileSinkConfig = z.infer<typeof configSchema>;

/**
 * Quote a field the way RFC 4180 says, which is also what spreadsheets expect.
 *
 * A value containing the delimiter, a quote, or a newline must be quoted, and
 * quotes inside are doubled. Getting this wrong does not throw — it produces a
 * file that opens with the columns silently shifted, which is the kind of bug
 * someone finds a month later in a report.
 */
export function escapeField(
  value: unknown,
  delimiter: string,
  newline: string,
  escapeFormulas = true,
): string {
  if (value === null || value === undefined) return '';
  const raw =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  const text = escapeFormulas && looksLikeFormula(raw) ? `'${raw}` : raw;
  const mustQuote =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text.includes(newline);
  return mustQuote ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Text Excel, Sheets and LibreOffice would run as a formula: after any leading
 * space, tab, or line break, it starts with `=`, `+`, `-`, or `@`. Quoting
 * does not stop that — a quoted `"=HYPERLINK(…)"` still runs — so the cell gets
 * a leading `'`, which the spreadsheet reads as "this is text". A plain number
 * such as `-5` or `+1.5e3` is left alone: it is data, and a `'` would turn it
 * into text.
 */
function looksLikeFormula(text: string): boolean {
  // Spreadsheets skip leading whitespace before deciding a cell is a formula,
  // so ` =cmd` is the same door as `=cmd`.
  let start = 0;
  while (start < text.length && ' \t\r\n'.includes(text[start]!)) start++;
  const body = text.slice(start);
  const first = body[0];
  if (first === '=' || first === '@') return true;
  if (first !== '+' && first !== '-') return false;
  // A signed number is data. `Number` reads `-5`, `+1.5e3` and `-.5` as
  // numbers and `-2+3` or `+cmd|…` as NaN.
  return !Number.isFinite(Number(body));
}

export function toRow(
  record: Record<string, unknown>,
  config: FileSinkConfig,
): string {
  return config.columns
    .map((column) => escapeField(record[column], config.delimiter, config.newline, config.escapeFormulas))
    .join(config.delimiter);
}

export class FileSinkPipe implements SinkPipe {
  readonly type = 'sink.file.delimited';
  readonly role = 'sink' as const;

  /**
   * Which paths this run has already opened. A sink is called once per batch,
   * and the header belongs to the file, not the batch — without this a
   * multi-batch run writes a header line between every chunk.
   */
  private readonly started = new Set<string>();

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Write CSV file',
      category: 'Output/File',
      family: 'file',
      tags: ['csv', 'export', 'spreadsheet'],
      version: '0.1.0',
      role: 'sink',
      // Writes to the filesystem: a dry run must not touch it.
      sideEffects: true,
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [],
      // The JSON Schema the designer's form reads is derived from the same zod
      // schema save and run validate with, so the two cannot disagree.
      configSchema,
    });
  }

  validateConfig(config: unknown): void {
    configSchema.parse(config);
  }

  finishRun(workflowRunId: string): void {
    const prefix = `${workflowRunId}:`;
    for (const key of this.started) if (key.startsWith(prefix)) this.started.delete(key);
  }

  async write(batch: RecordBatch, context: PipeContext): Promise<void> {
    const config = configSchema.parse(context.pipe.config);
    if (batch.records.length === 0) return;
    const file = await openWorkflowFile(config.path);

    const key = `${context.workflowRunId}:${file.path}`;
    const first = !this.started.has(key);
    if (first) this.started.add(key);

    const body =
      batch.records.map((record) => toRow(record, config)).join(config.newline) +
      config.newline;
    const header = config.header
      ? config.columns
          .map((column) => escapeField(column, config.delimiter, config.newline, config.escapeFormulas))
          .join(config.delimiter) + config.newline
      : '';

    // Overwrite truncates once per run, not once per batch — otherwise batch
    // two erases batch one and the file only ever holds the last chunk.
    if (first && config.mode === 'overwrite') {
      await file.write(header + body);
      return;
    }

    // Appending to a file that does not exist yet still needs its header;
    // appending to one that already has rows must not get a second.
    const lead = first && header && (await file.isEmpty()) ? header : '';
    await file.append(lead + body);
  }
}
