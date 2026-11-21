/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared GRANT/REVOKE helpers. Dialect files own the SQL; this file owns
 * validation, warnings, and privilege-name mapping.
 */
import { quoteSqlIdentifier } from '@foxschema/sql';
import {
  accessCapabilities,
  accessFamily,
  hasAccessModel,
  supportsAccessBuilder,
  describePermission,
  type AccessPermission,
  type AccessScope,
  type PermissionRequest,
} from './intent.js';
import { cellSupport, type GridObjectKind } from './object-grid.js';
import { nonSqlPermissionsReason } from './non-sql-engines.js';
import type { PermissionWarning } from './access-sql.types.js';

/** Privileges each intent maps to on table-shaped objects. */
const TABLE_PRIVILEGE: Partial<Record<AccessPermission, string>> = {
  read: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
};

export function tablePrivileges(permissions: readonly AccessPermission[]): string[] {
  return permissions.map((p) => TABLE_PRIVILEGE[p]).filter((p): p is string => !!p);
}

export function tablePermissions(permissions: readonly AccessPermission[]): AccessPermission[] {
  return permissions.filter((p) => !!TABLE_PRIVILEGE[p]);
}

export function executePermissions(permissions: readonly AccessPermission[]): AccessPermission[] {
  return permissions.filter((p) => p === 'execute-function' || p === 'execute-procedure');
}

/** Privilege names for the per-object columns the grid offers. */
const OBJECT_PRIVILEGE: Partial<Record<AccessPermission, string>> = {
  reference: 'REFERENCES',
  'index-object': 'INDEX',
  'trigger-object': 'TRIGGER',
  'alter-object': 'ALTER',
  'drop-object': 'DROP',
};

/**
 * The per-object privileges this engine can actually grant on this kind.
 *
 * Support is read from the grid's capability table rather than restated here,
 * so an emitter can never offer a privilege the grid greyed out — the two would
 * drift, and the direction of the drift is SQL that fails on the reader's
 * database after the UI told them it would work.
 */
export function objectPrivileges(
  permissions: readonly AccessPermission[],
  dialect: string,
  kind: GridObjectKind
): { privs: string[]; covers: AccessPermission[] } {
  const privs: string[] = [];
  const covers: AccessPermission[] = [];
  for (const p of permissions) {
    const name = OBJECT_PRIVILEGE[p];
    if (!name) continue;
    if (!cellSupport(dialect, kind, p).available) continue;
    privs.push(name);
    covers.push(p);
  }
  return { privs, covers };
}

/**
 * Routine names split by kind, because engines name the two apart.
 *
 * MySQL and Db2 write `ON PROCEDURE x` and `ON FUNCTION y`; Oracle names
 * neither. Grouping here keeps every emitter from repeating the partition.
 */
export function routinesByKind(scope: AccessScope): {
  procedures: string[];
  functions: string[];
} {
  if (scope.type !== 'routines') return { procedures: [], functions: [] };
  return {
    procedures: scope.routines.filter((r) => r.kind === 'procedure').map((r) => r.name),
    functions: scope.routines.filter((r) => r.kind === 'function').map((r) => r.name),
  };
}

export function ownershipPermissions(permissions: readonly AccessPermission[]): AccessPermission[] {
  return permissions.filter((p) => p === 'alter-object' || p === 'drop-object');
}

export function scopeSchema(scope: AccessScope): string {
  return scope.type === 'database' ? '' : scope.schema;
}

/**
 * A schema for a copy-and-edit hint. At database scope there is no schema to
 * name, and quoting the empty string gave `ON "".<table>` — a placeholder the
 * reader can fill in beats an identifier that only looks real.
 */
export function qualifier(ident: (n: string) => string, schema: string): string {
  return schema ? ident(schema) : '<schema>';
}

export function quoteAccessIdent(name: string, dialect: string): string {
  return quoteSqlIdentifier(name, dialect);
}

/**
 * Reject rather than approximate.
 *
 * A builder that quietly drops the part it cannot express leaves the reader
 * believing they granted something they did not — the worst possible failure
 * for a permissions tool.
 */
export function validateAccessRequest(request: PermissionRequest, dialect: string): string | null {
  const caps = accessCapabilities(dialect);
  const { scope, principal, permissions } = request;

  if (!principal?.name?.trim()) return 'Choose a user or role first.';
  if (permissions.length === 0) return 'Choose at least one permission.';

  // Engines with no GRANT model at all reach every check below with every
  // capability false, so they fell through to whichever scope-specific message
  // came first — Redis was told it "has no schema-level grants, select
  // individual tables instead", advice it can act on even less than the thing
  // it was refused, since Redis has no tables either. Say the real thing once.
  //
  // And where the engine does have a permission model that simply is not SQL,
  // name it. Redis enforces key patterns and command lists, MongoDB enforces
  // roles — both verified against live servers — so stopping at "Fox Schema
  // has no permission model" leaves the reader with nothing, on the screen
  // where they came looking for exactly that.
  if (!supportsAccessBuilder(dialect)) {
    return (
      nonSqlPermissionsReason(dialect) ??
      `Fox Schema has no permission model for ${dialect}, so there is nothing to generate here.`
    );
  }

  if (scope.type === 'database' && !caps.databaseScope) {
    return `${dialect} cannot grant at the database level.`;
  }
  if (scope.type === 'schema' && !caps.schemaScope) {
    return `${dialect} has no schema-level grants — select individual tables instead.`;
  }
  if (scope.type === 'tables') {
    if (!caps.tableScope) return `${dialect} cannot grant on individual tables.`;
    if (!scope.schema.trim()) return 'Choose the schema these tables live in.';
    if (scope.tables.length === 0) return 'Select at least one table.';
  }
  if (scope.type === 'columns') {
    if (!caps.columnScope) return `${dialect} cannot grant on individual columns.`;
    if (!scope.schema.trim()) return 'Choose the schema this table lives in.';
    if (!scope.table.trim()) return 'Enter the table name.';
    if (scope.columns.length === 0) return 'Select at least one column.';
  }
  if (scope.type === 'routines') {
    if (!caps.tableScope) return `${dialect} cannot grant on individual routines.`;
    if (!scope.schema.trim()) return 'Choose the schema these routines live in.';
    if (scope.routines.length === 0) return 'Select at least one procedure or function.';
  }
  if (scope.type === 'sequences') {
    if (!caps.sequenceScope) return `${dialect} cannot grant on sequences.`;
    if (!scope.schema.trim()) return 'Choose the schema these sequences live in.';
  }
  if (request.action === 'deny' && !caps.denyStatements) {
    return `${dialect} has no DENY statements — use revoke instead.`;
  }
  if (scope.type === 'schema' && !scope.schema.trim()) return 'Choose a schema.';
  if (scope.type === 'database' && !scope.database.trim()) return 'Choose a database.';

  if (request.includeFutureObjects && !caps.futureObjects) {
    // Not an error on engines whose schema grants already cover new objects —
    // handled as a warning below — but it is one where the toggle is simply
    // meaningless.
    if (scope.type === 'tables') {
      return 'Future objects do not apply when specific tables are selected.';
    }
  }
  if (request.withGrantOption && !caps.grantOption) {
    return `${dialect} does not support passing on privileges.`;
  }
  return null;
}

export function warnForAccess(request: PermissionRequest, dialect: string): PermissionWarning[] {
  const warnings: PermissionWarning[] = [];
  const caps = accessCapabilities(dialect);
  const fam = accessFamily(dialect);
  const { permissions } = request;

  if (permissions.includes('drop-object')) {
    warnings.push({
      level: 'danger',
      message:
        'Drop objects permanently removes tables, views and their data. Review the generated SQL before running it.',
    });
  }
  if (request.withGrantOption) {
    warnings.push({
      level: 'danger',
      message:
        'With grant option lets this principal pass the same access to anyone else, which puts further grants outside your review.',
    });
  }
  if (permissions.some((p) => p === 'create-object' || p === 'alter-object')) {
    warnings.push({
      level: 'caution',
      message: 'Creating and altering objects changes the schema your migrations compare against.',
    });
  }
  if (request.includeFutureObjects && fam === 'postgres') {
    warnings.push({
      level: 'caution',
      message:
        'ALTER DEFAULT PRIVILEGES only applies to objects created by the role that runs it. Run it as the role that will own the new tables, or add FOR ROLE to name that owner explicitly.',
    });
  }
  if (request.includeFutureObjects && !caps.futureObjects && request.scope.type === 'schema') {
    warnings.push({
      level: 'info',
      message: `${dialect} has no separate future-objects grant — a schema-level grant already covers objects added later.`,
    });
  }
  if (request.action === 'revoke') {
    warnings.push({
      level: 'info',
      message:
        'Revoking removes only what was granted directly. Access inherited through a role stays until that role changes.',
    });
  }
  if (request.action === 'deny') {
    warnings.push({
      level: 'caution',
      message:
        'DENY overrides grants, including through roles. A direct DENY blocks access even when a role would grant it.',
    });
  }
  // Anything without its own privilege model falls back to the PostgreSQL
  // shape; say so rather than passing it off as authoritative.
  if (!hasAccessModel(dialect)) {
    warnings.push({
      level: 'caution',
      message: `Fox Schema has no privilege model for ${dialect}; the statements below use PostgreSQL's GRANT syntax. Check them against your engine before running them.`,
    });
  }
  return warnings;
}

const PRIV_VERB: Record<string, string> = {
  SELECT: 'Read',
  INSERT: 'Insert',
  UPDATE: 'Update',
  DELETE: 'Delete',
  EXECUTE: 'Run routines',
  CREATE: 'Create objects',
  ALTER: 'Alter objects',
  DROP: 'Drop objects',
  // Db2's schema-wide forms, so the explanation reads in the same words as
  // every other engine's rather than echoing the keyword back.
  SELECTIN: 'Read',
  INSERTIN: 'Insert',
  UPDATEIN: 'Update',
  DELETEIN: 'Delete',
  EXECUTEIN: 'Run routines',
  ALTERIN: 'Alter objects',
  CREATEIN: 'Create objects',
  DROPIN: 'Drop objects',
};

/** "a", "a and b", "a, b and c" — one place, so every message reads the same. */
export function listWords(words: readonly string[]): string {
  if (words.length === 0) return '';
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function describePrivs(privs: readonly string[]): string {
  return listWords(privs.map((p) => PRIV_VERB[p] ?? p));
}

export function missedPermissionWarning(
  request: PermissionRequest,
  dialect: string,
  covered: ReadonlySet<AccessPermission>
): PermissionWarning | null {
  const missed = request.permissions.filter((p) => !covered.has(p));
  if (missed.length === 0) return null;
  const labels = missed.map((p) => describePermission(p).label.toLowerCase());
  const verb = request.action === 'grant' ? 'grants' : 'revokes';

  // Advice the reader can act on beats a general statement of the limitation.
  // Where the engine has per-object grants and the miss is a table privilege,
  // narrowing the scope is the whole answer — and it is the case people
  // actually hit, because "read only" on a database scope looks like it should
  // work and produces a runnable CREATE SESSION plus a commented template.
  const caps = accessCapabilities(dialect);
  const perObjectAvailable =
    caps.tableScope && (request.scope.type === 'database' || request.scope.type === 'schema');
  const tableLevel = missed.every(
    (p) => p === 'read' || p === 'insert' || p === 'update' || p === 'delete'
  );
  const act = request.action === 'grant' ? 'grant' : 'revoke';

  // Two different situations, and telling them apart matters. Db2 and
  // PostgreSQL do have schema-wide grants, so a miss at *database* scope means
  // "name a schema", not "this engine cannot do it" — saying the latter
  // contradicted the very statement the emitter had just produced. Oracle
  // genuinely has none, and there the only way through is per object.
  const remedy = !(perObjectAvailable && tableLevel)
    ? `Handle ${missed.length === 1 ? 'that one' : 'those'} through object ownership or an engine-specific privilege.`
    : caps.schemaScope && request.scope.type === 'database'
      ? `Choose a schema — ${dialect} ${act}s these per schema — or switch the scope to Tables and pick the objects.`
      : `Switch the scope to Tables and pick the objects to ${act} on — ${dialect} has no schema-wide table grant.`;

  return {
    level: 'caution',
    message: `${dialect} cannot express ${listWords(labels)} at this scope — nothing below ${verb} it. ${remedy}`,
  };
}
