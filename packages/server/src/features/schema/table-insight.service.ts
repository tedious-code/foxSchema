/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Catalog-only table insight for Peek / explorer. Never COUNT(DISTINCT).
 */
import { ConnectionFactory, type ConnectionOptions } from '@foxschema/db';
import { buildTableInsightQuery, dialectSupportsTableInsight, normalizeTableInsightRows, type TableInsightResult, type TableInsightSupport } from '@foxschema/features';

export async function probeTableInsight(opts: {
  dialect: string;
  option: ConnectionOptions;
  schema?: string;
  table: string;
}): Promise<
  | { ok: true; value: TableInsightResult }
  | { ok: false; failure: { status: number; error: string; support: TableInsightSupport } }
> {
  const support = dialectSupportsTableInsight(opts.dialect);
  if (!support.query) {
    return {
      ok: false,
      failure: {
        status: 400,
        error: support.hint || 'This dialect does not support table insight.',
        support,
      },
    };
  }
  const built = buildTableInsightQuery({
    dialect: opts.dialect,
    schema: opts.schema,
    table: opts.table,
  });
  if ('error' in built) {
    return { ok: false, failure: { status: 400, error: built.error, support } };
  }
  try {
    const raw = await ConnectionFactory.executeQuery<Record<string, unknown>>(
      opts.dialect,
      opts.option,
      built.sql,
      built.params
    );
    const norm = normalizeTableInsightRows(opts.dialect, raw);
    return {
      ok: true,
      value: {
        table: opts.table,
        schema: opts.schema ?? '',
        estimatedRows: norm.estimatedRows,
        sizeBytes: norm.sizeBytes,
        columns: norm.columns,
        mode: 'catalog',
        support,
        warning:
          norm.estimatedRows == null && norm.columns.length === 0
            ? `${support.hint} No statistics yet.`
            : undefined,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Table insight probe failed';
    return {
      ok: false,
      failure: { status: 500, error: `${message} — ${support.hint}`, support },
    };
  }
}
