/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Db2 GRANT/REVOKE. Table privileges are per object; schema-wide table grants
 * are a comment, not a guess.
 */
import { highestRisk, type AccessPermission } from '../../modules/access/intent.js';

/**
 * Db2's schema-wide privileges, in the order they read best in a statement.
 *
 * `…IN ON SCHEMA` covers every object of the matching kind in the schema, and
 * unlike PostgreSQL's ALL TABLES it keeps covering objects created later.
 */
const SCHEMA_IN_PRIVILEGE: readonly (readonly [AccessPermission, string])[] = [
  ['read', 'SELECTIN'],
  ['insert', 'INSERTIN'],
  ['update', 'UPDATEIN'],
  ['delete', 'DELETEIN'],
  ['execute-procedure', 'EXECUTEIN'],
  ['execute-function', 'EXECUTEIN'],
  ['alter-object', 'ALTERIN'],
  ['drop-object', 'DROPIN'],
];
import {
  describePrivs,
  executePermissions,
  objectPrivileges,
  routinesByKind,
  qualifier,
  scopeSchema,
  tablePermissions,
  tablePrivileges,
} from '../../modules/access/access-sql-helpers.js';
import type { AccessSqlDialect, EmitCtx } from '../../modules/access/access-sql.types.js';

function emitDb2(ctx: EmitCtx): void {
  const { request, grantee, ident, verb, dir, option, add } = ctx;
  const { scope, permissions } = request;
  const privs = tablePrivileges(permissions);
  const tablePerms = tablePermissions(permissions);
  const schema = scopeSchema(scope);
  // `grantee` already carries the USER/ROLE prefix from formatDbGrantee —
  // repeating it here produced `TO USER USER "REPORT_USER"`.

  if (permissions.includes('connect') && scope.type === 'database') {
    // Db2 database authorities cannot be passed on, so no WITH GRANT OPTION.
    add(
      `${verb} CONNECT ON DATABASE ${dir} ${grantee};`,
      `Lets ${request.principal.name} connect to the database.`,
      'low',
      ['connect']
    );
  }
  if (permissions.includes('create-object') && scope.type !== 'tables') {
    if (schema) {
      add(
        `${verb} CREATEIN ON SCHEMA ${ident(schema)} ${dir} ${grantee}${option};`,
        `Lets ${request.principal.name} create objects in ${schema}.`,
        'administrative',
        ['create-object']
      );
    } else {
      // At database scope there is no schema to name; CREATETAB is the database
      // authority that covers it. Falling back to the scope keyword emitted
      // `ON SCHEMA "database"`, a schema nobody has.
      add(
        `${verb} CREATETAB ON DATABASE ${dir} ${grantee};`,
        `Lets ${request.principal.name} create tables in the database. Db2 calls this the CREATETAB database authority.`,
        'administrative',
        ['create-object']
      );
    }
  }
  // Ahead of the empty-privilege return: an EXECUTE-only routine request has no
  // table privileges and would otherwise fall through to the "repeat per table"
  // comment, which says nothing about routines.
  if (scope.type === 'routines') {
    const execPerms = executePermissions(permissions);
    if (execPerms.length === 0) return;
    const { procedures, functions } = routinesByKind(scope);
    for (const [keyword, names] of [
      ['PROCEDURE', procedures],
      ['FUNCTION', functions],
    ] as const) {
      for (const name of names) {
        // Db2 refuses a routine REVOKE without RESTRICT (SQL0104N).
        const restrict = request.action === 'revoke' ? ' RESTRICT' : '';
        add(
          `${verb} EXECUTE ON ${keyword} ${ident(scope.schema)}.${ident(name)} ${dir} ${grantee}${option}${restrict};`,
          `Lets ${request.principal.name} run ${keyword.toLowerCase()} ${scope.schema}.${name}.`,
          'elevated',
          execPerms
        );
      }
    }
    return;
  }

  if (scope.type === 'tables') {
    const extra = objectPrivileges(permissions, ctx.dialect, 'table');
    for (const pv of extra.privs) if (!privs.includes(pv)) privs.push(pv);
    tablePerms.push(...extra.covers);
  }
  // Db2 *does* have schema-wide grants: the `…IN ON SCHEMA` privileges, which
  // apply to every object of the right kind in the schema, present and future.
  // This file previously said they "exist only for a few verbs" and emitted a
  // commented template instead. Verified against Db2 12.1: SELECTIN, INSERTIN,
  // UPDATEIN, DELETEIN, EXECUTEIN, ALTERIN, CREATEIN and DROPIN all grant and
  // all record in SYSCAT.SCHEMAAUTH.
  if (scope.type === 'schema' && schema) {
    const inPrivs: string[] = [];
    const covers: AccessPermission[] = [];
    for (const [permission, priv] of SCHEMA_IN_PRIVILEGE) {
      if (permissions.includes(permission)) {
        if (!inPrivs.includes(priv)) inPrivs.push(priv);
        covers.push(permission);
      }
    }
    if (inPrivs.length > 0) {
      add(
        `${verb} ${inPrivs.join(', ')} ON SCHEMA ${ident(schema)} ${dir} ${grantee}${option};`,
        `${describePrivs(inPrivs)} on every object in ${schema}, including objects added later. Db2 11.1 and later.`,
        highestRisk(permissions),
        covers
      );
      return;
    }
  }

  if (privs.length === 0) return;

  if (scope.type === 'tables') {
    for (const table of scope.tables) {
      add(
        `${verb} ${privs.join(', ')} ON TABLE ${ident(scope.schema)}.${ident(table)} ${dir} ${grantee}${option};`,
        `${describePrivs(privs)} on ${scope.schema}.${table}.`,
        highestRisk(permissions),
        tablePerms
      );
    }
    return;
  }
  // Database scope has no schema to name, so the per-object template is still
  // the honest answer there.
  add(
    `-- Db2 grants these per object or per schema. Repeat for each table:\n-- ${verb} ${privs.join(', ')} ON TABLE ${qualifier(ident, schema)}.<table> ${dir} ${grantee};`,
    'Choose a schema to use Db2’s schema-wide grants, or select individual tables.',
    highestRisk(permissions)
    // No `covers` — see the note in oracle.access-sql.ts. A commented-out
    // template cannot grant anything, so it must not silence the warning.
  );
}

export const db2AccessSql: AccessSqlDialect = {
  id: 'db2',
  emit: emitDb2,
};
