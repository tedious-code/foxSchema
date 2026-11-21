/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Catalog-only table insight facade. Dialects know catalog names; this file
 * does not.
 */
export type {
  TableInsightMode,
  TableInsightSupport,
  TableInsightQuery,
  TableInsightColumn,
  TableInsightResult,
  TableInsightTarget,
  TableInsightDialect,
} from './table-insight.types.js';
import type {
  TableInsightQuery,
  TableInsightSupport,
  TableInsightColumn,
} from './table-insight.types.js';
import { resolveTableInsight, TABLE_INSIGHT_MAP } from './table-insight.registry.js';

const UNSUPPORTED: TableInsightSupport = {
  mode: 'unsupported',
  query: false,
  hint: 'This dialect does not expose catalog table statistics.',
};

export function dialectSupportsTableInsight(dialect: string): TableInsightSupport {
  return resolveTableInsight(dialect)?.support ?? UNSUPPORTED;
}

export function buildTableInsightQuery(opts: {
  dialect: string;
  schema?: string;
  table: string;
}): TableInsightQuery | { error: string } {
  const impl = resolveTableInsight(opts.dialect);
  const support = impl?.support ?? UNSUPPORTED;
  if (!impl || !support.query) {
    return { error: support.hint || 'Unsupported dialect for table insight.' };
  }
  const table = (opts.table || '').trim();
  if (!table) return { error: 'table is required.' };
  return impl.probe({ schema: (opts.schema || '').trim(), table });
}

export function tableInsightDialectIds(): string[] {
  return Object.keys(TABLE_INSIGHT_MAP);
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** sqlite_stat1.stat is "N D1 D2…" — N is estimated rows, D1 is n_distinct of first col. */
export function parseSqliteStat1(stat: unknown): { estimatedRows: number | null; nDistinct: number | null } {
  const parts = String(stat ?? '')
    .trim()
    .split(/\s+/)
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n));
  return {
    estimatedRows: parts[0] ?? null,
    nDistinct: parts[1] ?? null,
  };
}

export function normalizeTableInsightRows(
  dialect: string,
  raw: unknown
): { estimatedRows: number | null; sizeBytes: number | null; columns: TableInsightColumn[] } {
  const rows: Record<string, unknown>[] = Array.isArray(raw) ? raw : [];
  const d = dialect.toLowerCase();
  const columns: TableInsightColumn[] = [];
  let estimatedRows: number | null = null;
  let sizeBytes: number | null = null;
  const seen = new Set<string>();
  for (const row of rows) {
    if (estimatedRows == null) {
      if (d === 'sqlite' || d === 'duckdb') {
        estimatedRows = parseSqliteStat1(row.n_distinct ?? row.stat).estimatedRows;
      } else {
        estimatedRows = num(row.estimated_rows ?? row.TABLE_ROWS ?? row.num_rows);
      }
    }
    if (sizeBytes == null) sizeBytes = num(row.size_bytes ?? row.SIZE_BYTES);
    const name = str(row.column_name ?? row.idx);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    if (d === 'sqlite' || d === 'duckdb') {
      const parsed = parseSqliteStat1(row.n_distinct ?? row.stat);
      columns.push({ name, nDistinct: parsed.nDistinct, nullFrac: null });
    } else {
      columns.push({
        name,
        nDistinct: num(row.n_distinct),
        nullFrac: num(row.null_frac),
      });
    }
  }
  return { estimatedRows, sizeBytes, columns };
}
