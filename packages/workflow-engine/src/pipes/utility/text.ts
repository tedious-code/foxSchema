/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/text.ts).
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
import {
  columnRuleFieldsSchema,
  columnRules,
  compileColumnRules,
  BatchEmitter,
  TextRowReader,
} from './delimited.js';
import { openWorkflowFile } from './workflow-files.js';

/**
 * The field shape, exported without the cross-field `.refine()` so callers
 * that need a variant (the designer's preview endpoint parses a config whose
 * `path` is optional, because the sample may be pasted inline) can build one
 * instead of restating every field.
 */
export const textConfigFields = z
  .object({
    path: z.string().min(1),
    // Physical lines to skip from the top (report preambles).
    offset: z.number().int().min(0).default(0),
    // `delimited` splits on delimiters; `fixed` slices positional columns.
    format: z.enum(['delimited', 'fixed']).default('delimited'),
    // Any of these splits a value; multi-character delimiters allowed.
    delimiters: z.array(z.string().min(1)).default([]),
    // Optional: splits one line into several records before field splitting.
    recordDelimiter: z.string().min(1).optional(),
    // Positional field names; positions beyond the list become field_N.
    fields: z.array(z.string().min(1)).default([]),
    // Fixed-width layout (1-based start), required when format is `fixed`.
    // Each column may declare a type plus multi-regex checks (null / length /
    // format) — validated and converted before the whole-record schema runs.
    columns: z
      .array(
        z.object({
          name: z.string().min(1),
          start: z.number().int().min(1),
          length: z.number().int().min(1),
          ...columnRuleFieldsSchema,
        }),
      )
      .default([]),
    // Same per-field rules for `delimited` format, matched to fields by name.
    rules: z
      .array(
        z.object({
          name: z.string().min(1),
          ...columnRuleFieldsSchema,
        }),
      )
      .default([]),
    // First content line: keep, always skip, or drop only when it names the
    // configured columns (feeds that sometimes ship a header, sometimes not).
    header: z.enum(['none', 'skip', 'auto']).default('none'),
    trim: z.boolean().default(true),
    skipEmpty: z.boolean().default(true),
    ...batchSizeField(),
    ...recordContractFields,
    ...rejectPolicyField,
  });

/**
 * `delimited` needs delimiters, `fixed` needs columns — a cross-field rule, so
 * it is applied on top of the fields rather than inside them. Exported so the
 * preview endpoint enforces the same rule it would hit at run time.
 */
export const textFormatRefine = {
  check: (config: { format: string; columns: unknown[]; delimiters: unknown[] }) =>
    config.format === 'fixed'
      ? config.columns.length > 0
      : config.delimiters.length > 0,
  message: 'delimited format needs delimiters; fixed format needs columns',
};

const configSchema = textConfigFields.refine(textFormatRefine.check, {
  message: textFormatRefine.message,
});

/**
 * Line-oriented text source. Two formats: `delimited` splits each line on an
 * optional record delimiter (flat map — one line can yield many records) then
 * on any configured field delimiter; `fixed` slices positional columns
 * (mainframe-style flat files). Optional header handling for feeds that
 * sometimes ship a header line. No CSV quoting rules.
 */
export class TextSourcePipe implements SourcePipe {
  readonly type = 'source.file.text';
  readonly role = 'source';

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Text file',
      category: 'Source/File',
      family: 'file',
      version: '0.4.0',
      role: 'source',
      inputs: [],
      outputs: [
        { name: 'out', type: 'records' },
        { name: REJECTS_PORT, type: 'records' },
      ],
      configSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    const parsed = configSchema.parse(config);
    // Fail fast on malformed regexes (config error) before a run starts.
    compileColumnRules(columnRules(parsed));
  }

  async *read(context: PipeContext): AsyncIterable<RecordBatch> {
    const config = configSchema.parse(context.pipe.config);
    const resumeAfter = Number(context.checkpoint?.cursor.line ?? 0);
    // Cut at line boundaries: a line flat-maps to several records, its cursor
    // is the line, and a line must never straddle two batches.
    const emitter = new BatchEmitter(context.pipe.id, config, {
      cursorKey: 'line',
      positionKey: '_line',
      label: 'line',
      cut: 'boundary',
    });
    // The same reader the designer preview uses, so the two cannot disagree.
    const reader = new TextRowReader(config, resumeAfter);
    for await (const line of readLines((await openWorkflowFile(config.path)).readStream())) {
      for (const row of reader.push(line)) {
        // A record a column rule refused is kept, if rejected, as the raw values.
        if (row.failure !== null) {
          emitter.add(row.record, row.line, { reason: 'validation', message: row.failure }, row.raw);
        } else {
          emitter.add(row.record, row.line);
        }
      }
      yield* emitter.drain();
    }
    yield* emitter.flush(reader.line);
  }
}

export async function* readLines(
  chunks: AsyncIterable<string | Buffer>,
): AsyncIterable<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += String(chunk);
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer.length > 0) yield buffer.replace(/\r$/, '');
}
