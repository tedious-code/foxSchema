/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Executes the statements a `-- @node` cell sends over the bridge.
 *
 * This is the trust boundary for `sql` inside a cell: the write policy, the
 * caller's permissions, and the row cap live here, in the API process, not in
 * the worker that runs user code.
 */

import { ConnectionFactory, sqlStatementCategories, type ConnectionOptions } from '@foxschema/db';
import { MAX_CELL_QUERY_ROWS } from './code-cell-bridge.service';
import type { CellQueryRunner } from './code-cell-execute.service';
import { CATEGORY_PERMISSION, type Permission } from '@foxschema/shared';

export interface CellQueryPolicy {
  /** Mirrors the editor's Safe mode: false blocks every non-read statement. */
  allowWrites: boolean;
  /**
   * The caller's effective permissions. Checked per statement because a cell
   * builds its SQL at runtime — the route cannot know up front whether a cell
   * will INSERT a row or GRANT a privilege.
   */
  can: (permission: Permission) => boolean;
}

/**
 * Turn positional driver rows into the object shape cells already consume.
 *
 * Cells (and Server Beam copies) read `row.id`, `row.name`, … — one key per
 * name. When a join selects `id` from two tables the driver can still hand
 * both values back as arrays, but packing them into an object would keep only
 * the last one. `/sql/execute` already prefers positional rows for that
 * reason; the bridge used to stay on the name-keyed path, so a Beam cell that
 * `SELECT *`'d a join and wrote the objects elsewhere silently persisted the
 * wrong table's values.
 *
 * Fail closed when names collide: inventing `id_2` would still surprise a
 * write that expected `id`, and blanking the duplicate would drop data. Alias
 * in the SELECT list instead so every value reaches the cell under a unique key.
 */
export function objectRowsFromPositional(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[]
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const name of columns) {
    if (seen.has(name)) {
      if (!dupes.includes(name)) dupes.push(name);
    } else {
      seen.add(name);
    }
  }
  if (dupes.length > 0) {
    throw new Error(
      `sql\`…\` returned duplicate column names (${dupes.join(', ')}). ` +
        `Alias them in the SELECT list (e.g. orders.id AS order_id) so every ` +
        `value reaches the cell — object rows cannot keep two columns with the same name.`
    );
  }
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]!] = row[i];
    }
    return obj;
  });
}

/**
 * Build the bridge runner for one resolved connection.
 *
 * Both checks matter and neither replaces the other: Safe mode is the user's
 * own guard rail, while the permission check is what the role system promises.
 * Without the second, `allowWrites` would be a blanket pass and an editor could
 * run `GRANT` from a cell — escalating past the `editor.grant` boundary that
 * exists precisely to stop that.
 */
export function makeCellQueryRunner(
  resolved: { dialect: string; option: ConnectionOptions },
  policy: CellQueryPolicy
): CellQueryRunner {
  return async (text: string, params: unknown[]) => {
    const sql = text.trim();
    if (!sql) throw new Error('Empty statement');

    // Fail-closed, same classifier as the /sql/execute gate: an unrecognized
    // verb lands in `ddl` rather than slipping through as a read. Batches are
    // classified per statement so a leading SELECT cannot hide a write/GRANT,
    // and read as this connection's database reads them.
    const categories = sqlStatementCategories(sql, resolved.dialect);
    for (const category of categories) {
      if (category === 'read') continue;
      if (!policy.allowWrites) {
        throw new Error(
          'Safe mode is on — this cell tried to run a write/DDL statement. ' +
            'Turn Safe mode off (or confirm the run) to allow writes from code cells.'
        );
      }
      const permission = CATEGORY_PERMISSION[category];
      if (permission && !policy.can(permission)) {
        throw new Error(
          `Permission denied: this cell tried to run a statement requiring "${permission}".`
        );
      }
    }

    // Prefer positional when the driver offers it: that is the only path that
    // can see a join's duplicate column names before they collapse into an
    // object. Drivers without it (SQLite, Oracle, Db2, …) keep the name-keyed
    // path — same residual as the SQL Editor grid on those engines.
    const connection = await ConnectionFactory.create(resolved.dialect, resolved.option);
    try {
      const positional = ConnectionFactory.executePositional(
        resolved.dialect,
        connection,
        sql,
        params
      );
      let rows: Record<string, unknown>[];
      if (positional) {
        const shaped = await positional;
        const rawRows = Array.isArray(shaped.rows) ? shaped.rows : [];
        if (rawRows.length > MAX_CELL_QUERY_ROWS) {
          throw new Error(
            `sql\`…\` returned ${rawRows.length} rows; the bridge refuses more than ` +
              `${MAX_CELL_QUERY_ROWS}. Add LIMIT / chunk the query so the cell sees a complete result.`
          );
        }
        rows = objectRowsFromPositional(
          Array.isArray(shaped.columns) ? shaped.columns : [],
          rawRows
        );
      } else {
        const raw = await ConnectionFactory.executeOnConnection<Record<string, unknown>>(
          resolved.dialect,
          connection,
          sql,
          params
        );
        rows = Array.isArray(raw) ? raw : [];
        // Fail closed: silently returning a prefix lets a cell treat a partial
        // SELECT as complete (e.g. DELETE … WHERE id IN (…ids…)) and corrupt data.
        // Cap stays for structured-clone / memory; callers must LIMIT or chunk.
        if (rows.length > MAX_CELL_QUERY_ROWS) {
          throw new Error(
            `sql\`…\` returned ${rows.length} rows; the bridge refuses more than ` +
              `${MAX_CELL_QUERY_ROWS}. Add LIMIT / chunk the query so the cell sees a complete result.`
          );
        }
      }
      return rows;
    } finally {
      await ConnectionFactory.close(resolved.dialect, connection);
    }
  };
}

/**
 * Server Beam router: pick a per-alias runner. Unknown aliases fail closed.
 */
export function makeBeamCellQueryRunner(
  byAlias: Map<string, CellQueryRunner>,
  defaultAlias?: string
): CellQueryRunner {
  return async (text, params, alias) => {
    const key = alias ?? defaultAlias;
    if (!key) {
      throw new Error('Server Beam query missing alias — use sql.on("source") or sql.on("target")');
    }
    const runner = byAlias.get(key);
    if (!runner) {
      const known = [...byAlias.keys()].join(', ') || '(none)';
      throw new Error(`Unknown Server Beam alias "${key}". Known: ${known}`);
    }
    return runner(text, params, key);
  };
}
