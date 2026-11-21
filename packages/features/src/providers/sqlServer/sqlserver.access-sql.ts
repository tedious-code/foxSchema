/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Server / Azure SQL GRANT/REVOKE/DENY (`OBJECT::` / `SCHEMA::`).
 */
import { highestRisk } from '../../modules/access/intent.js';
import {
  describePrivs,
  objectPrivileges,
  executePermissions,
  tablePermissions,
  tablePrivileges,
} from '../../modules/access/access-sql-helpers.js';
import type { AccessSqlDialect, EmitCtx } from '../../modules/access/access-sql.types.js';

function emitSqlServer(ctx: EmitCtx): void {
  const { request, grantee, ident, verb, dir, option, add } = ctx;
  const { scope, permissions } = request;
  const privs = tablePrivileges(permissions);
  const covers = [...tablePermissions(permissions)];
  const execPerms = executePermissions(permissions);
  if (permissions.includes('alter-object')) {
    privs.push('ALTER');
    covers.push('alter-object');
  }
  // EXECUTE is for routines (or schema/database-wide). Putting it on a table
  // OBJECT:: grant is not what a Tables-scoped request asked for, and it is
  // how a leftover procedure-executor preset over-granted.
  if (execPerms.length > 0 && scope.type !== 'tables' && scope.type !== 'columns') {
    privs.push('EXECUTE');
    covers.push(...execPerms);
  }
  // DROP is not a SQL Server permission — ALTER on the container carries it —
  // so `drop-object` stays uncovered and buildAccessSql says so.
  if (scope.type === 'tables' || scope.type === 'routines' || scope.type === 'columns') {
    const kind = scope.type === 'routines' ? 'procedure' : 'table';
    const extra = objectPrivileges(permissions, ctx.dialect, kind);
    for (const pv of extra.privs) if (!privs.includes(pv)) privs.push(pv);
    covers.push(...extra.covers);
  }

  if (permissions.includes('connect') && scope.type === 'database') {
    add(
      `${verb} CONNECT ${dir} ${grantee}${option};`,
      `Lets ${request.principal.name} connect to the current database.`,
      'low',
      ['connect']
    );
  }
  // CREATE TABLE is database-wide. A Tables-scoped request that still carries
  // create-object must not pick it up from a stale Manage-schema preset.
  if (
    permissions.includes('create-object') &&
    (scope.type === 'database' || scope.type === 'schema')
  ) {
    add(
      `${verb} CREATE TABLE ${dir} ${grantee}${option};`,
      `Lets ${request.principal.name} create tables in this database.`,
      'administrative',
      ['create-object']
    );
  }
  if (privs.length === 0) return;

  if (scope.type === 'routines') {
    // Without this branch a routine request falls through to the database-wide
    // `GRANT EXECUTE TO x`, which grants execute on every routine in the
    // database rather than the ones ticked.
    for (const routine of scope.routines) {
      add(
        `${verb} ${privs.join(', ')} ON OBJECT::${ident(scope.schema)}.${ident(routine.name)} ${dir} ${grantee}${option};`,
        `${describePrivs(privs)} on ${routine.kind} ${scope.schema}.${routine.name}.`,
        highestRisk(permissions),
        covers
      );
    }
    return;
  }

  if (scope.type === 'columns') {
    const colList = scope.columns.map((c) => ident(c)).join(', ');
    add(
      `${verb} ${privs.join(', ')} ON OBJECT::${ident(scope.schema)}.${ident(scope.table)} (${colList}) ${dir} ${grantee}${option};`,
      `${describePrivs(privs)} on ${scope.columns.length} column(s) of ${scope.schema}.${scope.table}.`,
      highestRisk(permissions),
      covers
    );
    return;
  }

  if (scope.type === 'tables') {
    for (const table of scope.tables) {
      add(
        `${verb} ${privs.join(', ')} ON OBJECT::${ident(scope.schema)}.${ident(table)} ${dir} ${grantee}${option};`,
        `${describePrivs(privs)} on ${scope.schema}.${table}.`,
        highestRisk(permissions),
        covers
      );
    }
    return;
  }
  if (scope.type === 'schema') {
    add(
      `${verb} ${privs.join(', ')} ON SCHEMA::${ident(scope.schema)} ${dir} ${grantee}${option};`,
      `${describePrivs(privs)} on everything in ${scope.schema}, including objects added later — SQL Server schema grants cover future objects automatically.`,
      highestRisk(permissions),
      covers
    );
    return;
  }
  add(
    `${verb} ${privs.join(', ')} ${dir} ${grantee}${option};`,
    `${describePrivs(privs)} across the whole database.`,
    highestRisk(permissions),
    covers
  );
}

export const sqlServerAccessSql: AccessSqlDialect = {
  id: 'sqlserver',
  emit: emitSqlServer,
};
