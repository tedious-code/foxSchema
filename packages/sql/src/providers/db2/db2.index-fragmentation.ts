/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Db2 index fragmentation: empty-leaf ratio from SYSCAT.INDEXES (an estimate)
 * plus LASTUSED, which Db2 keeps in the catalog itself.
 */
import {
  CUSTOM_HINT,
  quoteIndexTarget,
  type IndexFragmentationDialect,
} from '../../modules/utilities/index-fragmentation.types.js';

/**
 * Qualified table for a REORG/RUNSTATS command.
 *
 * The schema is folded: it is what the user typed in the connection field,
 * and schema browse looks it up with `toUpperCase()`. The table is not: every
 * caller passes the name schema browse read from SYSCAT.TABLES, which is
 * already what the catalog stores. Folding it too would aim a table created
 * as `"orders"` at `ORDERS` — SQL2211N if there is none, or someone else's
 * table if there is.
 */
function db2ReorgTarget(schema: string, table: string): string {
  const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';
  const folded = schema.trim().toUpperCase();
  const qualified = folded ? `${quote(folded)}.${quote(table.trim())}` : quote(table.trim());
  return qualified.replace(/'/g, "''");
}

const PROBE_SQL = `
SELECT
  INDNAME AS index_name,
  CASE
    WHEN NLEAF IS NULL OR NLEAF = 0 THEN NULL
    ELSE DECIMAL(100.0 * FLOAT(COALESCE(NUM_EMPTY_LEAFS, 0)) / FLOAT(NLEAF), 5, 2)
  END AS fragmentation_percent,
  NLEAF AS page_count,
  CASE
    WHEN LASTUSED IS NULL OR LASTUSED <= DATE('1971-01-01') THEN NULL
    ELSE LASTUSED
  END AS last_used,
  CAST(NULL AS BIGINT) AS scan_count
FROM SYSCAT.INDEXES
WHERE TABSCHEMA = ?
  AND TABNAME = ?
ORDER BY INDNAME
`.trim();

export const db2IndexFragmentation: IndexFragmentationDialect = {
  id: 'db2',
  support: {
    mode: 'estimated',
    query: true,
    defrag: true,
    hint: 'DB2: empty-leaf ratio from SYSCAT.INDEXES (estimate) plus LASTUSED. Use REORGCHK custom SQL for fuller guidance.',
    customSqlHint: CUSTOM_HINT,
  },
  maintenanceVerb: 'Reorg',
  probe(target) {
    if (!target.schema) return { error: 'DB2 fragmentation probe needs a schema name.' };
    return {
      mode: 'estimated',
      // The same names REORG uses, below: schema folded, table as the catalog has it.
      params: [target.schema.toUpperCase(), target.table.trim()],
      sql: PROBE_SQL,
    };
  },
  usageQueries() {
    // LASTUSED is already on the main probe.
    return [];
  },
  defragSql(target) {
    // Three things make Db2 unlike every other dialect here, each verified
    // against a live server:
    //
    // 1. It cannot reorganise a single index. `REORG INDEX <name>` returns
    //    SQL0270N "Function not supported (Reason code 89)". Only the
    //    table-level `REORG INDEXES ALL FOR TABLE` form exists, so selecting
    //    one index necessarily reorganises every index on its table.
    // 2. REORG is a command, not SQL. Sent over a driver connection it is
    //    rejected by the statement parser (SQL0104N, "expected tokens may
    //    include: JOIN"). It has to be handed to SYSPROC.ADMIN_CMD.
    // 3. Unquoted names are stored in uppercase. Schema browse looks the
    //    typed schema up that way, but quoting the typed case
    //    (`"demo_a"."ORDERS"`, `"App"."ORDERS"`) makes REORG answer SQL2211N
    //    "The specified table does not exist" for a table the probe just
    //    listed. Fold the schema before quoting. The table name came from
    //    the catalog and keeps its case (see db2ReorgTarget).
    //
    // The name is embedded in a string literal, so any single quote in an
    // identifier has to be doubled or it would end the literal early.
    // RUNSTATS follows because the percentage on this screen is read from
    // SYSCAT.INDEXES, which REORG does not update by itself.
    const literal = db2ReorgTarget(target.schema, target.table);
    return [
      `CALL SYSPROC.ADMIN_CMD('REORG INDEXES ALL FOR TABLE ${literal}');`,
      `CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE ${literal} AND INDEXES ALL');`,
      `-- Db2 has no single-index REORG: this reorganises every index on ${target.table}.`,
    ];
  },
  dropSql(target, indexName) {
    return [`DROP INDEX ${quoteIndexTarget(target).indexQualified(indexName)};`];
  },
  customTemplate(target) {
    const literal = (name: string) => name.replace(/'/g, "''");
    const sch = literal((target.schema || 'schema').toUpperCase());
    const tbl = literal(target.table || 'table');
    return `SELECT INDNAME AS index_name,
       DECIMAL(100.0 * FLOAT(COALESCE(NUM_EMPTY_LEAFS,0)) / NULLIF(FLOAT(NLEAF),0), 5, 2)
         AS fragmentation_percent,
       CASE WHEN LASTUSED IS NULL OR LASTUSED <= DATE('1971-01-01') THEN NULL ELSE LASTUSED END AS last_used
FROM SYSCAT.INDEXES
WHERE TABSCHEMA = '${sch}' AND TABNAME = '${tbl}';`;
  },
};
