/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Oracle GRANT/REVOKE. System privileges take WITH ADMIN OPTION; object
 * privileges take WITH GRANT OPTION. A schema is a user — no schema-wide
 * table grant.
 */
import { highestRisk, type AccessPermission } from '../../modules/access/intent.js';
import {
  describePrivs,
  executePermissions,
  objectPrivileges,
  qualifier,
  scopeSchema,
  tablePermissions,
  tablePrivileges,
} from '../../modules/access/access-sql-helpers.js';
import type { AccessSqlDialect, EmitCtx } from '../../modules/access/access-sql.types.js';

function emitOracle(ctx: EmitCtx): void {
  const { request, grantee, ident, verb, dir, option, add } = ctx;
  const { scope, permissions } = request;
  const privs = tablePrivileges(permissions);
  const tablePerms = tablePermissions(permissions);
  // Oracle system privileges take WITH ADMIN OPTION; WITH GRANT OPTION is only
  // valid on object privileges and raises ORA-00990 here.
  const adminOption = option ? ' WITH ADMIN OPTION' : '';

  // CREATE SESSION is instance-wide. Only emit it when the request is actually
  // about the database — a Tables-scoped leftover from read-only/schema
  // presets must not unlock login as a side effect.
  if (permissions.includes('connect') && scope.type === 'database') {
    add(
      `${verb} CREATE SESSION ${dir} ${grantee}${adminOption};`,
      `Lets ${request.principal.name} open a session. Oracle calls this CREATE SESSION rather than CONNECT.`,
      'low',
      ['connect']
    );
  }
  // CREATE TABLE is a system privilege for the grantee's own schema — not a
  // per-object grant. Emitting it on a Tables-scoped request (stale Manage
  // schema preset) would widen far past the named tables.
  if (
    permissions.includes('create-object') &&
    (scope.type === 'database' || scope.type === 'schema')
  ) {
    add(
      `${verb} CREATE TABLE ${dir} ${grantee}${adminOption};`,
      `Lets ${request.principal.name} create tables in their own schema.`,
      'administrative',
      ['create-object']
    );
  }
  // Oracle names no PROCEDURE/FUNCTION keyword in GRANT: the object name alone
  // identifies the routine. This runs before the empty-privilege return below,
  // because an EXECUTE-only request has no table privileges at all and would
  // otherwise emit nothing.
  if (scope.type === 'routines') {
    const routinePrivs: string[] = [];
    const routineCovers: AccessPermission[] = [];
    const execPerms = executePermissions(permissions);
    if (execPerms.length > 0) {
      routinePrivs.push('EXECUTE');
      routineCovers.push(...execPerms);
    }
    const extra = objectPrivileges(permissions, ctx.dialect, 'procedure');
    routinePrivs.push(...extra.privs);
    routineCovers.push(...extra.covers);
    if (routinePrivs.length === 0) return;
    for (const routine of scope.routines) {
      add(
        `${verb} ${routinePrivs.join(', ')} ON ${ident(scope.schema)}.${ident(routine.name)} ${dir} ${grantee}${option};`,
        `${describePrivs(routinePrivs)} on ${routine.kind} ${scope.schema}.${routine.name}.`,
        highestRisk(permissions),
        routineCovers
      );
    }
    return;
  }

  if (scope.type === 'tables') {
    const extra = objectPrivileges(permissions, ctx.dialect, 'table');
    for (const pv of extra.privs) if (!privs.includes(pv)) privs.push(pv);
    tablePerms.push(...extra.covers);
  }
  if (privs.length === 0) return;

  if (scope.type === 'tables') {
    for (const table of scope.tables) {
      add(
        `${verb} ${privs.join(', ')} ON ${ident(scope.schema)}.${ident(table)} ${dir} ${grantee}${option};`,
        `${describePrivs(privs)} on ${scope.schema}.${table}.`,
        highestRisk(permissions),
        tablePerms
      );
    }
    return;
  }
  add(
    `-- Oracle grants object privileges per object. Repeat for each table:\n-- ${verb} ${privs.join(', ')} ON ${qualifier(ident, scopeSchema(scope))}.<table> ${dir} ${grantee};`,
    'Oracle has no schema-wide table grant; a schema is a user. Select individual tables to generate runnable statements.',
    highestRisk(permissions)
    // No `covers`: this is a template, not a statement. Claiming it covered
    // read/insert/update/delete told `missedPermissionWarning` the job was
    // done, so the preview carried no warning at all — and a reader who
    // pasted it granted CREATE SESSION and nothing else.
  );
}

export const oracleAccessSql: AccessSqlDialect = {
  id: 'oracle',
  emit: emitOracle,
};
