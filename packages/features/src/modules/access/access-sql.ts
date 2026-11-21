/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Turns an intent-level PermissionRequest into the statements one engine
 * actually needs.
 *
 * The count is not one-to-one and that is the whole point: "read the reporting
 * schema, including future tables" is three statements on PostgreSQL (USAGE,
 * SELECT ON ALL TABLES, ALTER DEFAULT PRIVILEGES) and one on SQL Server. Every
 * statement carries its own explanation, because a reader who is about to run
 * unfamiliar SQL against production deserves to know what each line does.
 *
 * Nothing here executes anything. FoxSchema generates and explains; the
 * database stays the source of truth.
 *
 * ## Per-dialect emitters
 *
 * GRANT/REVOKE SQL lives in `providers/<engine>/<engine>.access-sql.ts`,
 * registered in {@link resolveAccessSql}. This file validates, dispatches, and
 * reports permissions the emitter could not cover.
 */
import { formatDbGrantee } from './db-access.js';
import { highestRisk, type AccessPermission, type PermissionRequest } from './intent.js';
import {
  missedPermissionWarning,
  quoteAccessIdent,
  validateAccessRequest,
  warnForAccess,
} from './access-sql-helpers.js';
import { resolveAccessSql } from './access-sql.registry.js';
import type { GeneratedPermissionSql, GeneratedStatement } from './access-sql.types.js';

export {
  type AccessWarningLevel,
  type GeneratedPermissionSql,
  type GeneratedStatement,
  type PermissionWarning,
  type AccessSqlDialect,
  type EmitCtx,
} from './access-sql.types.js';

export { resolveAccessSql, ACCESS_SQL_MAP } from './access-sql.registry.js';

/**
 * Build the statements for one request.
 *
 * Returns `{ error }` when the intent cannot be represented for this engine at
 * this scope, so the caller can say so instead of showing approximate SQL.
 */
export function buildAccessSql(
  request: PermissionRequest,
  dialect: string
): GeneratedPermissionSql | { error: string } {
  const invalid = validateAccessRequest(request, dialect);
  if (invalid) return { error: invalid };

  const grantee = formatDbGrantee(
    dialect,
    request.principal.name,
    request.principal.type === 'role' ? 'role' : 'user'
  );
  const ident = (n: string) => quoteAccessIdent(n, dialect);
  const verb =
    request.action === 'deny' ? 'DENY' : request.action === 'grant' ? 'GRANT' : 'REVOKE';
  const dir = request.action === 'revoke' ? 'FROM' : 'TO';
  const option = request.action === 'grant' && request.withGrantOption ? ' WITH GRANT OPTION' : '';

  const statements: GeneratedStatement[] = [];
  // Every emitter declares which requested permissions each statement accounts
  // for. Anything left over is a permission this engine's emitter cannot
  // express — the reader is told, instead of the intent quietly disappearing
  // between the checkbox they ticked and the SQL they copy.
  const covered = new Set<AccessPermission>();
  const add = (
    sql: string,
    explanation: string,
    risk: GeneratedStatement['risk'],
    covers: readonly AccessPermission[] = []
  ) => {
    statements.push({ sql, explanation, risk });
    for (const p of covers) covered.add(p);
  };

  resolveAccessSql(dialect).emit({
    request,
    dialect,
    grantee,
    ident,
    verb,
    dir,
    option,
    add,
  });

  if (statements.length === 0) {
    return { error: 'That combination produces no statements for this engine.' };
  }

  const warnings = warnForAccess(request, dialect);
  const missed = missedPermissionWarning(request, dialect, covered);
  if (missed) warnings.push(missed);
  return {
    statements,
    warnings,
    risk: highestRisk(request.permissions, request.withGrantOption),
  };
}

/**
 * The mirror-image request, for the "Generate REVOKE SQL" affordance.
 *
 * Not a text transform of the generated SQL: some statements have no inverse
 * (ALTER DEFAULT PRIVILEGES needs its own REVOKE form), so the request is
 * flipped and regenerated.
 */
export function invertAccessRequest(request: PermissionRequest): PermissionRequest {
  const action: PermissionRequest['action'] =
    request.action === 'grant' ? 'revoke' : request.action === 'deny' ? 'revoke' : 'grant';
  return {
    ...request,
    action,
    // Passing on privileges is not something you revoke *with*; dropping the
    // flag keeps WITH GRANT OPTION out of the REVOKE statements.
    withGrantOption: false,
  };
}
