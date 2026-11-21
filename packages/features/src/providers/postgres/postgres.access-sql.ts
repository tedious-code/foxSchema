/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL GRANT/REVOKE (also the fallback shape for Postgres-wire engines).
 */
import { highestRisk, type AccessPermission } from '../../modules/access/intent.js';
import {
  describePrivs,
  executePermissions,
  objectPrivileges,
  ownershipPermissions,
  routinesByKind,
  scopeSchema,
  tablePermissions,
  tablePrivileges,
} from '../../modules/access/access-sql-helpers.js';
import type { AccessSqlDialect, EmitCtx } from '../../modules/access/access-sql.types.js';

function emitPostgres(ctx: EmitCtx): void {
  const { request, grantee, ident, verb, dir, option, add } = ctx;
  const { scope, permissions } = request;
  const privs = tablePrivileges(permissions);
  const tablePerms = tablePermissions(permissions);
  const schema = scopeSchema(scope);

  // REFERENCES and TRIGGER are real PostgreSQL table privileges, and only
  // meaningful on a named object — the grid is the only thing that offers them.
  if (scope.type === 'tables' || scope.type === 'columns') {
    const extra = objectPrivileges(permissions, ctx.dialect, 'table');
    for (const pv of extra.privs) if (!privs.includes(pv)) privs.push(pv);
    tablePerms.push(...extra.covers);
  }

  if (permissions.includes('connect') && scope.type === 'database') {
    add(
      `${verb} CONNECT ON DATABASE ${ident(scope.database)} ${dir} ${grantee}${option};`,
      `Lets ${request.principal.name} open a connection to ${scope.database}. On its own this grants no access to any data.`,
      'low',
      ['connect']
    );
  }

  // Reaching into a schema is a prerequisite the reader should not have to know
  // about — without USAGE, a SELECT grant silently does nothing. Only pair
  // USAGE with GRANTs (and with schema-wide REVOKEs). Revoking SELECT on one
  // table must not strip USAGE that other table grants still need.
  if (
    schema &&
    permissions.some((p) => p !== 'connect') &&
    (request.action === 'grant' ||
      (request.action === 'revoke' && (scope.type === 'schema' || scope.type === 'database')))
  ) {
    add(
      `${verb} USAGE ON SCHEMA ${ident(schema)} ${dir} ${grantee}${option};`,
      request.action === 'grant'
        ? `Lets ${request.principal.name} reach objects inside ${schema}. This alone does not allow reading any data.`
        : `Removes schema reachability for ${request.principal.name} in ${schema}.`,
      'low'
    );
  }

  if (privs.length > 0) {
    if (scope.type === 'columns') {
      const colList = scope.columns.map((c) => ident(c)).join(', ');
      add(
        `${verb} ${privs.join(', ')} (${colList}) ON ${ident(schema)}.${ident(scope.table)} ${dir} ${grantee}${option};`,
        `${describePrivs(privs)} on ${scope.columns.length} column(s) of ${schema}.${scope.table}.`,
        highestRisk(permissions),
        tablePerms
      );
    } else if (scope.type === 'tables') {
      for (const table of scope.tables) {
        add(
          `${verb} ${privs.join(', ')} ON ${ident(schema)}.${ident(table)} ${dir} ${grantee}${option};`,
          `${describePrivs(privs)} on ${schema}.${table}.`,
          highestRisk(permissions),
          tablePerms
        );
      }
    } else if (scope.type === 'schema') {
      add(
        `${verb} ${privs.join(', ')} ON ALL TABLES IN SCHEMA ${ident(schema)} ${dir} ${grantee}${option};`,
        `${describePrivs(privs)} on every table that exists in ${schema} right now. Tables created later are not included.`,
        highestRisk(permissions),
        tablePerms
      );
    } else {
      // PostgreSQL has no database-wide table grant: privileges are granted in
      // whichever database the session is connected to, one schema at a time.
      // Naming both facts beats a statement that looks broader than it is.
      add(
        `${verb} ${privs.join(', ')} ON ALL TABLES IN SCHEMA ${ident('public')} ${dir} ${grantee}${option};`,
        `${describePrivs(privs)} on every table in the public schema. Run it while connected to ${scope.database} — PostgreSQL applies grants to the current database only — and grant other schemas separately.`,
        highestRisk(permissions),
        tablePerms
      );
    }
  }

  if (request.includeFutureObjects && privs.length > 0 && scope.type === 'schema') {
    add(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(schema)} ${verb} ${privs.join(', ')} ON TABLES ${dir} ${grantee};`,
      `Applies the same access to tables created in ${schema} from now on. Only affects tables created by the role that runs this statement.`,
      highestRisk(permissions),
      tablePerms
    );
  }

  if (permissions.some((p) => p === 'use-sequence' || (p === 'read' && scope.type === 'sequences'))) {
    const seqPerms: string[] = [];
    const seqCovers: AccessPermission[] = [];
    if (permissions.includes('use-sequence')) {
      seqPerms.push('USAGE');
      seqCovers.push('use-sequence');
    }
    if (permissions.includes('read') && scope.type === 'sequences') {
      seqPerms.push('SELECT');
      seqCovers.push('read');
    }
    if (seqPerms.length > 0 && schema) {
      if (scope.type === 'sequences' && scope.sequences?.length) {
        for (const seq of scope.sequences) {
          add(
            `${verb} ${seqPerms.join(', ')} ON SEQUENCE ${ident(schema)}.${ident(seq)} ${dir} ${grantee}${option};`,
            `Sequence access on ${schema}.${seq}.`,
            'low',
            seqCovers
          );
        }
      } else {
        add(
          `${verb} ${seqPerms.join(', ')} ON ALL SEQUENCES IN SCHEMA ${ident(schema)} ${dir} ${grantee}${option};`,
          `Sequence access on every sequence in ${schema}.`,
          'low',
          seqCovers
        );
      }
    }
  }

  // CREATE belongs on a schema or database, never on a named-table request.
  // A tables-scoped request that still carries create-object (stale preset /
  // scope switch) must not widen into GRANT CREATE ON SCHEMA.
  if (permissions.includes('create-object')) {
    if (scope.type === 'schema' && schema) {
      add(
        `${verb} CREATE ON SCHEMA ${ident(schema)} ${dir} ${grantee}${option};`,
        `Lets ${request.principal.name} create new objects inside ${schema}.`,
        'administrative',
        ['create-object']
      );
    } else if (scope.type === 'database') {
      add(
        `${verb} CREATE ON DATABASE ${ident(scope.database)} ${dir} ${grantee}${option};`,
        `Lets ${request.principal.name} create new schemas in ${scope.database}. Creating tables also needs CREATE on the schema that will hold them.`,
        'administrative',
        ['create-object']
      );
    }
  }

  const execPerms = executePermissions(permissions);
  if (execPerms.length > 0 && scope.type === 'routines') {
    // Named routines only. Falling through to ALL ROUTINES would grant EXECUTE
    // on every routine in the schema — far more than the reader ticked, and a
    // permissions tool that silently widens a grant is worse than one that
    // refuses.
    const { procedures, functions } = routinesByKind(scope);
    for (const [keyword, names] of [
      ['FUNCTION', functions],
      ['PROCEDURE', procedures],
    ] as const) {
      for (const name of names) {
        add(
          `${verb} EXECUTE ON ${keyword} ${ident(schema)}.${ident(name)} ${dir} ${grantee}${option};`,
          `Lets ${request.principal.name} run ${schema}.${name}. PostgreSQL identifies routines by argument types too; add them if the name is overloaded.`,
          'elevated',
          execPerms
        );
      }
    }
  } else if (
    execPerms.length > 0 &&
    (scope.type === 'schema' || scope.type === 'database')
  ) {
    // Schema / database only. Tables and columns scopes that still carry
    // execute-* (a preset clicked while "Tables" is selected, or a leftover
    // after switching scope) must not fall through to ALL ROUTINES — that
    // grants every routine in the schema while the UI is naming specific tables.
    const routineSchema = schema || 'public';
    add(
      `${verb} EXECUTE ON ALL ROUTINES IN SCHEMA ${ident(routineSchema)} ${dir} ${grantee}${option};`,
      `Lets ${request.principal.name} run functions and procedures that exist in ${routineSchema} now.`,
      'elevated',
      execPerms
    );
    if (request.includeFutureObjects) {
      add(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${ident(routineSchema)} ${verb} EXECUTE ON ROUTINES ${dir} ${grantee};`,
        `Applies the same to routines created in ${routineSchema} from now on.`,
        'elevated',
        execPerms
      );
    }
  }

  // ALTER and DROP are ownership in PostgreSQL, not grantable privileges — say
  // so rather than emitting SQL that will not do what the reader expects.
  const ownerPerms = ownershipPermissions(permissions);
  if (ownerPerms.length > 0) {
    add(
      // Membership runs role → member: the principal joins the owning role, not
      // the other way round.
      `-- PostgreSQL has no ALTER or DROP privilege: only an object's owner (or a\n-- member of its owning role) may alter or drop it. Consider:\n-- ${verb} <owning_role> ${dir} ${ident(request.principal.name)};`,
      'PostgreSQL controls altering and dropping through ownership, not grants. Add the principal to the owning role instead.',
      'critical'
      // No `covers` — the statement is a comment. Ownership is the answer, and
      // the reader needs that as a warning, not only as prose under a line
      // that does nothing when run.
    );
  }
}

export const postgresAccessSql: AccessSqlDialect = {
  id: 'postgres',
  emit: emitPostgres,
};
