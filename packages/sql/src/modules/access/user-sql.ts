/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * DDL for database accounts: create, alter and drop a user or a role.
 *
 * This generates SQL and nothing else. Fox Schema does not create accounts —
 * the statements are shown to a DBA to review and run. That is why there is no
 * matching execute path and no capability here for applying anything.
 *
 * ## Passwords are never handled
 *
 * A password belongs in the DBA's hands, not in a browser tab, a React state
 * tree or a history record. Statements that need one are emitted with the
 * {@link PASSWORD_PLACEHOLDER} in its place and a warning to substitute it
 * before running. Nothing here accepts a password argument, so there is no path
 * by which one could be stored or logged.
 *
 * ## A user is not a role
 *
 * The two are separate on every engine that has both, and conflating them is
 * the usual source of confusion: a role holds privileges, a user logs in.
 * {@link PrincipalType} makes the caller choose, and the emitters differ
 * accordingly — most visibly on SQL Server, where a login and a database user
 * are two objects and creating an account means creating both.
 *
 * ## Per-dialect modules
 *
 * Emitters live next to migration dialects as
 * `packages/sql/src/providers/<name>/<name>.user-sql.ts` and are registered in
 * {@link resolveUserSql}. This stays in `@foxschema/sql` (pure, browser-safe) —
 * not `@foxschema/db`, which is Node drivers only.
 */
export {
  PASSWORD_PLACEHOLDER,
  type PrincipalType,
  type UserAction,
  type UserAlteration,
  type UserRequest,
  type GeneratedUserSql,
  type UserManagementSupport,
  type UserSqlDialect,
} from './user-sql.types.js';

export {
  buildDb2OsUserInstructions,
  DEFAULT_DB2_RUN_MODE,
  type Db2RunMode,
  generateDb2OsPassword,
  validateDb2OsPassword,
  DB2_OS_PASSWORD_LENGTH,
  DB2_DOCKER_CONTAINER,
  DB2_DOCKER_DATABASE,
} from '../../providers/db2/db2.user-sql.js';

import type { GeneratedUserSql, UserManagementSupport, UserRequest } from './user-sql.types.js';
import type { GeneratedStatement } from './access-sql.types.js';
import { resolveUserSql } from './user-sql.registry.js';
import { buildGrantRevokeSql } from './db-access.js';
import { mysqlAccount, mysqlRoleRef } from './user-sql-helpers.js';
import { accessFamily } from './intent.js';

export function userManagementSupport(dialect: string): UserManagementSupport {
  return { ...resolveUserSql(dialect).support };
}

/**
 * Build the DDL for one account change.
 *
 * Returns `{ error }` rather than approximate SQL when the engine cannot
 * express the request — running a statement that is nearly right against an
 * account is worse than being told it is not possible.
 */
export function buildUserSql(
  request: UserRequest,
  dialect: string
): GeneratedUserSql | { error: string } {
  const name = request.name.trim();
  if (!name) return { error: 'Enter a name for the account.' };

  const impl = resolveUserSql(dialect);
  const support = impl.support;
  if (!support.supported) {
    return { error: support.reason ?? 'Not supported on this engine.' };
  }

  const isUser = request.principalType === 'user';
  if (isUser && !support.canCreateUser && request.action === 'create') {
    return { error: support.reason ?? 'This engine cannot create users in SQL.' };
  }

  const built = impl.build({ ...request, name }, dialect);
  if ('error' in built) return built;
  const roles = (request.roles ?? []).map((r) => r.trim()).filter(Boolean);
  if (request.action !== 'create' || roles.length === 0) return built;
  const memberships = roleMembershipStatements(request, name, roles, dialect);
  if ('error' in memberships) return memberships;
  return { ...built, statements: [...built.statements, ...memberships] };
}

/**
 * GRANT each chosen role to the account just created.
 *
 * On the MySQL family a granted role is inactive until the session turns it on,
 * so without a default role the new account logs in holding none of what it
 * was just given. MySQL and TiDB take `ALL`; MariaDB takes exactly one.
 */
function roleMembershipStatements(
  request: UserRequest,
  name: string,
  roles: string[],
  dialect: string
): GeneratedStatement[] | { error: string } {
  const fam = accessFamily(dialect);
  const mysqlFamily = fam === 'mysql' || fam === 'mariadb';
  const isUser = request.principalType === 'user';
  const grantee = mysqlFamily && isUser ? `${name}@${request.host?.trim() || '%'}` : name;
  const out: GeneratedStatement[] = [];
  for (const role of roles) {
    const built = buildGrantRevokeSql({
      dialect,
      action: 'grant',
      privilege: role,
      objectType: 'ROLE',
      objectName: role,
      grantee,
      granteeKind: request.principalType,
    });
    if ('error' in built) return built;
    out.push({
      sql: built.sql,
      explanation: `Adds ${name} to ${role}, so it holds everything ${role} holds.`,
      risk: 'elevated',
    });
  }
  if (!mysqlFamily || !isUser) return out;
  // The account exactly as the CREATE USER above it names it.
  const account = mysqlAccount(name, request.host);
  if (fam === 'mariadb') {
    const others = roles.length > 1 ? '; the others are switched on with SET ROLE' : '';
    out.push({
      sql: `SET DEFAULT ROLE ${mysqlRoleRef(roles[0]!, undefined, dialect)} FOR ${account};`,
      explanation: `Turns ${roles[0]} on at login. MariaDB keeps one default role${others}.`,
      risk: 'low',
    });
  } else {
    out.push({
      sql: `SET DEFAULT ROLE ALL TO ${account};`,
      explanation: 'Turns the granted roles on at login. MySQL leaves a granted role inactive otherwise.',
      risk: 'low',
    });
  }
  return out;
}
