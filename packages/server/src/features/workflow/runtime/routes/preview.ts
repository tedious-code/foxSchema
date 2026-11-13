/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/routes/preview.ts).
 */
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '../zod-provider.js';
import {
  csvConfigFields,
  invalidRecords,
  parseCsvRecords,
  parseTextRows,
  textConfigFields,
  textFormatRefine,
  openWorkflowFile,
} from '@foxschema/workflow-engine';

/** At most this much of a file is read for a preview. */
const HEAD_BYTES = 256 * 1024;
const MAX_ROWS = 500;

const previewBodySchema = z.object({
  kind: z.enum(['csv', 'text']),
  /** The source pipe's config, as saved on the node. */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Inline sample to parse; when absent, the head of `config.path` is read. */
  sample: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).default(50),
});

/**
 * The preview parses the *pipe's own* config, with one difference: `path` is
 * optional here because the sample may be pasted into the designer instead of
 * read from disk. Restating the fields is what made preview and run disagree
 * before — deriving keeps the preview honest about what a run would do.
 */
const csvConfigSchema = csvConfigFields.partial({ path: true });

const textConfigSchema = textConfigFields
  .partial({ path: true })
  .refine(textFormatRefine.check, { message: textFormatRefine.message });

const previewResponseSchema = z.object({
  fields: z.array(z.string()),
  records: z.array(z.record(z.string(), z.unknown())),
  /**
   * 1-based source line for each visible record (parallel to `records`).
   * The physical file/sample line the record starts on, for text and CSV alike.
   */
  lines: z.array(z.number().int().min(1)).default([]),
  invalid: z.array(
    z.object({
      index: z.number(),
      /** 1-based source line when known (text parses). */
      line: z.number().int().min(1).optional(),
      message: z.string(),
    }),
  ),
  total: z.number(),
  /** True when the source was cut (file head, row limit) — counts are partial. */
  truncated: z.boolean(),
  error: z.string().nullable(),
});

type PreviewResponse = z.infer<typeof previewResponseSchema>;

const failure = (error: string): PreviewResponse => ({
  fields: [],
  records: [],
  lines: [],
  invalid: [],
  total: 0,
  truncated: false,
  error,
});

/**
 * Parse a sample (or the head of the configured file) with the same code the
 * source pipes run, so the designer preview shows exactly what a run would
 * produce — including which rows the schema (regex and all) rejects.
 */
export function previewRoutes(): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/preview/parse',
      {
        schema: {
          body: previewBodySchema,
          response: { 200: previewResponseSchema },
        },
      },
      async (req): Promise<PreviewResponse> => {
        const { kind, config, sample, limit } = req.body;
        const parsed =
          kind === 'csv'
            ? csvConfigSchema.safeParse(config)
            : textConfigSchema.safeParse(config);
        if (!parsed.success) {
          return failure(
            `config: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.')} ${issue.message}`)
              .join('; ')}`,
          );
        }

        let text = sample;
        let headTruncated = false;
        if (text === undefined) {
          const path = parsed.data.path;
          if (!path) return failure('provide a sample or set a file path');
          try {
            // The head of the file, through the same root-confined handle a
            // run reads with; a partial last line is dropped.
            ({ text, truncated: headTruncated } = await (await openWorkflowFile(path)).readHead(HEAD_BYTES, {
              wholeLines: true,
            }));
          } catch (error) {
            return failure(`read ${path}: ${(error as Error).message}`);
          }
        }

        try {
          let fields: string[];
          let records: Record<string, unknown>[];
          // 1-based source line per record (text only; CSV uses row = index+1).
          let recordLines: number[] = [];
          // Column-rule failures (type/regex), collected during parsing.
          let ruleFailures: {
            index: number;
            line?: number;
            message: string;
          }[] = [];
          if (kind === 'csv') {
            const csv = csvConfigSchema.parse(config);
            // Where each record starts, read by the scanner the run uses: a
            // count of preamble + header + index was wrong after any quoted
            // field that spans lines.
            ({ headers: fields, records, lines: recordLines } = await parseCsvRecords(text, csv));
          } else {
            const opts = textConfigSchema.parse(config);
            ({
              records,
              invalid: ruleFailures,
              lines: recordLines,
            } = parseTextRows(text, opts));
            if (opts.format === 'fixed') {
              fields = opts.columns.map((column) => column.name);
            } else {
              const width = Math.max(
                opts.fields.length,
                ...records.map((record) => Object.keys(record).length),
                0,
              );
              fields = Array.from(
                { length: width },
                (_, i) => opts.fields[i] ?? `field_${i + 1}`,
              );
            }
          }
          const total = records.length;
          const visible = records.slice(0, limit);
          // A row that already failed its column rules is not re-reported by
          // the whole-record schema — one row, one reason, the first one.
          const ruleInvalid = ruleFailures.filter((row) => row.index < visible.length);
          const failedByRule = new Set(ruleInvalid.map((row) => row.index));
          const schemaInvalid = invalidRecords(visible, parsed.data.schema)
            .filter((row) => !failedByRule.has(row.index))
            .map((row) => ({
              ...row,
              line: recordLines[row.index],
            }));
          return {
            fields,
            records: visible,
            lines: recordLines.slice(0, visible.length),
            invalid: [...ruleInvalid, ...schemaInvalid].sort(
              (a, b) => a.index - b.index,
            ),
            total,
            truncated: headTruncated || total > visible.length,
            error: null,
          };
        } catch (error) {
          return failure((error as Error).message);
        }
      },
    );
  };
  return plugin;
}
