/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The object × privilege grid behind the permission builder.
 *
 * The flat builder asks for one permission set and one scope, so granting a
 * reader SELECT on four tables and EXECUTE on two procedures is four visits to
 * the form. This module models the whole answer at once: rows are objects,
 * columns are privileges, and a cell is a checkbox.
 *
 * Most of the file is the table saying which cells an engine can actually
 * express. That table is the point. A grid drawn without it looks uniform and
 * is not: `ALTER` on a named table is a privilege in MySQL, SQL Server, Oracle
 * and Db2, and in PostgreSQL it is ownership — there is no GRANT that confers
 * it. `DROP` is narrower still: only the MySQL family has it per object. A grid
 * that offers those cells everywhere generates SQL that fails on half the
 * engines it was drawn for, and the reader is told nothing until the database
 * refuses it.
 *
 * `CREATE` is absent from every object row on purpose. It cannot be granted on
 * a named object, because the object does not exist yet — it is a schema- or
 * database-scoped privilege, and it belongs to the scope selector rather than
 * to a row.
 *
 * Nothing here knows a GRANT keyword; it decides *what* is expressible and the
 * dialect emitters decide how to write it.
 */
import type {
  AccessPermission,
  AccessPrincipal,
  AccessScope,
  PermissionRequest,
} from './intent.js';
import { accessFamily } from './intent.js';
import type { DbPrivilege } from './db-access.js';

/** The kinds of object a grid row can stand for. */
export type GridObjectKind = 'table' | 'view' | 'procedure' | 'function';

/** One row: a named object and the privileges ticked on it. */
export interface GridRow {
  kind: GridObjectKind;
  /** Native casing — this reaches SQL, so it is an identifier, not a match key. */
  name: string;
  schema?: string;
  permissions: readonly AccessPermission[];
}

/**
 * The columns offered per object kind, in display order.
 *
 * Tables and views carry the data privileges; routines carry EXECUTE. Both
 * carry ALTER and DROP, which the capability table then withdraws per engine.
 */
export const GRID_COLUMNS: Record<GridObjectKind, readonly AccessPermission[]> = {
  table: [
    'read',
    'insert',
    'update',
    'delete',
    'reference',
    'index-object',
    'trigger-object',
    'alter-object',
    'drop-object',
  ],
  // A view is updatable often enough to be worth offering, but it has no
  // indexes or triggers of its own in the engines that support the grid.
  view: ['read', 'insert', 'update', 'delete', 'reference', 'alter-object', 'drop-object'],
  procedure: ['execute-procedure', 'alter-object', 'drop-object'],
  function: ['execute-function', 'alter-object', 'drop-object'],
};

/** Why a cell is unavailable, or how it is expressed when it is. */
export interface CellSupport {
  available: boolean;
  /** Always set. On an unavailable cell this is the sentence shown on hover. */
  reason: string;
}

const OWNERSHIP_NOT_PRIVILEGE =
  'PostgreSQL has no GRANT for this — changing an object requires owning it. Transfer ownership or use a role that owns the object.';

/**
 * Per-object privileges each engine can grant, by family.
 *
 * Sources are the engines' own GRANT grammars, and the omissions are the
 * load-bearing part:
 *
 *   - PostgreSQL: SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER on a table.
 *     ALTER and DROP are ownership, not privileges.
 *   - MySQL/MariaDB: the widest set, including DROP and INDEX on `db.tbl`, and
 *     ALTER ROUTINE on a named routine.
 *   - SQL Server: ALTER on OBJECT:: yes; DROP is not an object privilege (it
 *     comes with ALTER on the containing schema, or CONTROL).
 *   - Oracle: ALTER and INDEX on a table; no per-object DROP — dropping another
 *     schema's table needs the DROP ANY TABLE system privilege.
 *   - Db2: ALTER, INDEX and REFERENCES on a table; DROP comes with CONTROL.
 */
const OBJECT_PRIVILEGES: Record<string, Partial<Record<GridObjectKind, readonly AccessPermission[]>>> = {
  postgres: {
    table: ['read', 'insert', 'update', 'delete', 'reference', 'trigger-object'],
    view: ['read', 'insert', 'update', 'delete', 'reference'],
    procedure: ['execute-procedure'],
    function: ['execute-function'],
  },
  mysql: {
    table: [
      'read',
      'insert',
      'update',
      'delete',
      'reference',
      'index-object',
      'trigger-object',
      'alter-object',
      'drop-object',
    ],
    view: ['read', 'insert', 'update', 'delete', 'reference', 'alter-object', 'drop-object'],
    procedure: ['execute-procedure', 'alter-object'],
    function: ['execute-function', 'alter-object'],
  },
  // accessFamily() keeps MariaDB distinct from MySQL, so it needs its own
  // entry — without one every MariaDB cell would read as unsupported.
  mariadb: {
    table: [
      'read',
      'insert',
      'update',
      'delete',
      'reference',
      'index-object',
      'trigger-object',
      'alter-object',
      'drop-object',
    ],
    view: ['read', 'insert', 'update', 'delete', 'reference', 'alter-object', 'drop-object'],
    procedure: ['execute-procedure', 'alter-object'],
    function: ['execute-function', 'alter-object'],
  },
  sqlserver: {
    table: ['read', 'insert', 'update', 'delete', 'reference', 'alter-object'],
    view: ['read', 'insert', 'update', 'delete', 'reference', 'alter-object'],
    procedure: ['execute-procedure', 'alter-object'],
    function: ['execute-function', 'alter-object'],
  },
  oracle: {
    table: ['read', 'insert', 'update', 'delete', 'reference', 'index-object', 'alter-object'],
    view: ['read', 'insert', 'update', 'delete'],
    procedure: ['execute-procedure', 'alter-object'],
    function: ['execute-function', 'alter-object'],
  },
  db2: {
    table: ['read', 'insert', 'update', 'delete', 'reference', 'index-object', 'alter-object'],
    view: ['read', 'insert', 'update', 'delete'],
    procedure: ['execute-procedure'],
    function: ['execute-function'],
  },
};

/** Engine-specific wording for a cell that cannot be expressed. */
const UNAVAILABLE_REASON: Record<string, Partial<Record<AccessPermission, string>>> = {
  postgres: {
    'alter-object': OWNERSHIP_NOT_PRIVILEGE,
    'drop-object': OWNERSHIP_NOT_PRIVILEGE,
    'index-object': 'PostgreSQL has no INDEX privilege — creating an index requires owning the table.',
  },
  sqlserver: {
    'drop-object':
      'SQL Server has no DROP object privilege. Dropping comes with ALTER on the containing schema, or CONTROL on the object.',
  },
  oracle: {
    'drop-object':
      'Oracle has no per-object DROP privilege. Dropping another schema’s object needs the DROP ANY TABLE system privilege.',
  },
  db2: {
    'drop-object': 'Db2 has no DROP object privilege — it comes with CONTROL on the object.',
    'alter-object': 'Db2 grants ALTER on tables, not on routines.',
  },
};

const GENERIC_UNAVAILABLE = 'This engine cannot grant this privilege on a single object.';

/**
 * Can this engine grant this privilege on this kind of object?
 *
 * Unavailable cells are still drawn, disabled, carrying the reason. A missing
 * checkbox tells the reader nothing and they go looking for it; "PostgreSQL has
 * no GRANT for this — changing an object requires owning it" tells them why the
 * grid cannot do what they came to do, and what would.
 */
export function cellSupport(
  dialect: string,
  kind: GridObjectKind,
  permission: AccessPermission
): CellSupport {
  const family = accessFamily(dialect);
  const forFamily = OBJECT_PRIVILEGES[family];
  if (!forFamily) {
    return { available: false, reason: 'This engine has no GRANT model for individual objects.' };
  }
  const allowed = forFamily[kind];
  if (!allowed) {
    return { available: false, reason: `This engine cannot grant privileges on a ${kind}.` };
  }
  if (allowed.includes(permission)) {
    return { available: true, reason: '' };
  }
  return {
    available: false,
    reason: UNAVAILABLE_REASON[family]?.[permission] ?? GENERIC_UNAVAILABLE,
  };
}

/** The columns worth drawing for a kind — every column, with support attached. */
export function gridColumnsFor(
  dialect: string,
  kind: GridObjectKind
): { permission: AccessPermission; support: CellSupport }[] {
  return GRID_COLUMNS[kind].map((permission) => ({
    permission,
    support: cellSupport(dialect, kind, permission),
  }));
}

/** Drop cells this engine cannot express, so a stale tick never reaches SQL. */
export function prunedPermissions(
  dialect: string,
  kind: GridObjectKind,
  permissions: readonly AccessPermission[]
): AccessPermission[] {
  return permissions.filter((p) => cellSupport(dialect, kind, p).available);
}

const SCOPE_FOR_KIND: Record<GridObjectKind, 'tables' | 'routines'> = {
  table: 'tables',
  view: 'tables',
  procedure: 'routines',
  function: 'routines',
};

export interface CompileGridOptions {
  dialect: string;
  principal: AccessPrincipal;
  action: 'grant' | 'revoke' | 'deny';
  /** Fallback for rows that carry no schema of their own. */
  schema: string;
  withGrantOption?: boolean;
}

/**
 * Turn a grid into the requests the SQL layer already understands.
 *
 * Rows that ended up with the same privileges collapse into one request, so
 * ticking Read on twelve tables produces `GRANT SELECT ON a, b, c …` rather
 * than twelve statements. Grouping is by privilege set *and* schema *and* kind:
 * merging across any of those would produce a statement naming objects the
 * privilege list does not suit.
 *
 * Rows whose ticks are all unavailable on this engine vanish rather than
 * emitting an empty GRANT.
 */
export function compileObjectGrid(
  rows: readonly GridRow[],
  options: CompileGridOptions
): PermissionRequest[] {
  const { dialect, principal, action, schema: fallbackSchema, withGrantOption } = options;

  // Key on kind + schema + the privilege set, sorted so tick order never
  // changes the grouping.
  const groups = new Map<string, { row: GridRow; names: string[]; permissions: AccessPermission[] }>();

  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const permissions = prunedPermissions(dialect, row.kind, row.permissions);
    if (permissions.length === 0) continue;

    const schema = row.schema?.trim() || fallbackSchema;
    const key = [row.kind, schema, [...permissions].sort().join(',')].join(' ');
    const existing = groups.get(key);
    if (existing) {
      // The same object listed twice would produce `ON a, a` — harmless in
      // some engines, an error in others, and confusing in all of them.
      if (!existing.names.includes(name)) existing.names.push(name);
      continue;
    }
    groups.set(key, { row: { ...row, schema }, names: [name], permissions });
  }

  const requests: PermissionRequest[] = [];
  for (const group of groups.values()) {
    const { row, names, permissions } = group;
    const schema = row.schema ?? fallbackSchema;
    const scope: AccessScope =
      SCOPE_FOR_KIND[row.kind] === 'routines'
        ? {
            type: 'routines',
            schema,
            routines: names.map((name) => ({
              name,
              kind: row.kind === 'procedure' ? 'procedure' : 'function',
            })),
          }
        : { type: 'tables', schema, tables: names };

    requests.push({
      principal,
      action,
      permissions,
      scope,
      ...(withGrantOption ? { withGrantOption: true } : {}),
    });
  }
  return requests;
}

/** The key a grid row and a held privilege share: schema, kind and name, case-folded. */
export function gridObjectKey(o: { schema?: string | null; kind: GridObjectKind; name: string }): string {
  return `${(o.schema ?? '').trim().toLowerCase()}.${o.kind}.${o.name.trim().toLowerCase()}`;
}

/** The privilege names engines report for each cell. */
const CELL_PRIVILEGE: Partial<Record<AccessPermission, string>> = {
  read: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  reference: 'REFERENCES',
  'index-object': 'INDEX',
  'trigger-object': 'TRIGGER',
  'alter-object': 'ALTER',
  'drop-object': 'DROP',
  'execute-procedure': 'EXECUTE',
  'execute-function': 'EXECUTE',
};

/** Spellings of "every privilege on this object". */
const EVERY_PRIVILEGE = new Set(['ALL', 'ALL PRIVILEGES', 'CONTROL']);

/**
 * What a principal already holds, cell by cell, on the objects a grid shows.
 *
 * The grid used to open with every box empty, so a role that could already
 * read twenty tables looked like it could read none — and because the SQL
 * compared the ticks with the catalog, ticking one box produced REVOKEs for the
 * other nineteen. Opening on this map makes a ticked box mean "holds it" and an
 * empty one "does not", which is what a reader assumes they mean.
 *
 * Only grants on a named object count, and only ones a cell can show: a
 * schema-wide or database-wide grant is a different scope, and a privilege the
 * grid has no column for is not this grid's to display or to revoke. DENY rows
 * are not held. `privileges` is expected to be this principal's already.
 */
export function heldGridPermissions(
  privileges: readonly DbPrivilege[],
  objects: readonly { schema?: string | null; kind: GridObjectKind; name: string }[],
  dialect: string
): Map<string, AccessPermission[]> {
  // A privilege row names schema and object; the grid knows the kind. Rows
  // whose schema is not reported (MySQL's by-name grants) match on name alone.
  const byName = new Map<string, { schema?: string | null; kind: GridObjectKind; name: string }[]>();
  for (const o of objects) {
    const n = o.name.trim().toLowerCase();
    byName.set(n, [...(byName.get(n) ?? []), o]);
  }
  const held = new Map<string, AccessPermission[]>();
  for (const p of privileges) {
    if (p.state === 'deny' || !p.objectName) continue;
    const privilege = (p.privilege || '').trim().toUpperCase();
    const schema = (p.objectSchema ?? '').trim().toLowerCase();
    const candidates = (byName.get(p.objectName.trim().toLowerCase()) ?? []).filter(
      (o) => !schema || (o.schema ?? '').trim().toLowerCase() === schema
    );
    for (const o of candidates) {
      const cells = prunedPermissions(
        dialect,
        o.kind,
        GRID_COLUMNS[o.kind].filter((c) => EVERY_PRIVILEGE.has(privilege) || CELL_PRIVILEGE[c] === privilege)
      );
      if (cells.length === 0) continue;
      const key = gridObjectKey(o);
      held.set(key, [...new Set([...(held.get(key) ?? []), ...cells])]);
    }
  }
  return held;
}

/** What a grid edit changes: GRANTs for new ticks, REVOKEs for held ones cleared. */
export interface GridChanges {
  grant: PermissionRequest[];
  revoke: PermissionRequest[];
}

/**
 * Compile a grid against what the principal already holds.
 *
 * Only differences become SQL: a new tick is a GRANT, a held box cleared is a
 * REVOKE, and a box that matches the catalog — ticked or not — is nothing. A
 * held privilege on an object that is not a row, or that no cell can show, is
 * never touched: the grid cannot display it, so clearing it cannot have been
 * what the reader meant.
 */
export function compileGridChanges(
  rows: readonly GridRow[],
  held: ReadonlyMap<string, readonly AccessPermission[]>,
  options: Omit<CompileGridOptions, 'action'>
): GridChanges {
  const added: GridRow[] = [];
  const removed: GridRow[] = [];
  for (const row of rows) {
    const had = held.get(gridObjectKey({ ...row, schema: row.schema?.trim() || options.schema })) ?? [];
    added.push({ ...row, permissions: row.permissions.filter((p) => !had.includes(p)) });
    removed.push({ ...row, permissions: had.filter((p) => !row.permissions.includes(p)) });
  }
  return {
    grant: compileObjectGrid(added, { ...options, action: 'grant' }),
    revoke: compileObjectGrid(removed, { ...options, action: 'revoke', withGrantOption: false }),
  };
}

/**
 * Expand a database-scoped request across every database on the connection.
 *
 * This is what "instance" means in the builder: the same grant, applied to each
 * database the connection can see. It is deliberately not a cluster-level
 * privilege — those are a different vocabulary (CREATE DATABASE, CREATEROLE)
 * and belong to the system section rather than to a scope that fans out.
 */
export function expandToInstance(
  request: PermissionRequest,
  databases: readonly string[]
): PermissionRequest[] {
  const names = databases.map((d) => d.trim()).filter(Boolean);
  if (names.length === 0) return [request];
  return names.map((database) => ({ ...request, scope: { type: 'database', database } }));
}

/** Group identical statements that apply to the same place, not across databases. */
export function accessStatementPlace(scope: AccessScope): string {
  if (scope.type === 'database') return `database:${scope.database}`;
  if ('schema' in scope && scope.schema) return `schema:${scope.schema}`;
  return '';
}

/**
 * Database-scoped GRANT on Db2 and SQL Server does not name the database —
 * you are already connected to it. Fanning the same SQL across databases
 * then looks identical in the preview. A comment says which database to run
 * it in, so a later unique-by-text pass cannot collapse them into one.
 */
export function qualifyDatabaseSql(sql: string, scope: AccessScope): string {
  if (scope.type !== 'database') return sql;
  const db = scope.database.trim();
  if (!db) return sql;
  if (sql.toLowerCase().includes(db.toLowerCase())) return sql;
  return `-- run in ${db}\n${sql}`;
}
