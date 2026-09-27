/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared helpers for per-dialect account DDL (`*.user-sql.ts`).
 */
import type { PermissionRisk } from './intent.js';
import type { GeneratedStatement, PermissionWarning } from './access-sql.types.js';
import { quoteSqlIdentifier } from '../sql-text/sql-template.js';
import { nonSqlAccountsReason } from './non-sql-engines.js';
import {
  PASSWORD_PLACEHOLDER,
  type GeneratedUserSql,
  type UserManagementSupport,
  type UserRequest,
  type UserSqlDialect,
} from './user-sql.types.js';

export const UNSUPPORTED_USER_SQL: UserManagementSupport = {
  supported: false,
  canCreateUser: false,
  canCreateRole: false,
  canDisable: false,
  canRename: false,
  canExpire: false,
  reason: 'This engine has no database accounts to manage.',
};

/**
 * Why one engine's accounts are out of reach, in that engine's own terms.
 *
 * "This engine has no database accounts to manage" is true of SQLite and
 * DuckDB, where a file's owner is the access control. It is simply false of
 * Redis and MongoDB, which both have full account systems. The per-engine
 * wording — and the evidence behind every command it names — lives in
 * `non-sql-engines.ts`, beside the matching message for the permission
 * builder, because the two said different things while describing the same
 * two engines.
 */

/** MySQL-family string literals treat `\` as an escape — double it before quotes. */
export function mysqlQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** MySQL identifies an account by user and host together. */
export function mysqlAccount(name: string, host: string | undefined): string {
  return `${mysqlQuote(name)}@${mysqlQuote(host?.trim() || '%')}`;
}

/**
 * How a *role* is named, which is not how a user is named on every engine.
 *
 * MariaDB roles have no host part and reject one outright: `CREATE ROLE
 * 'r'@'%'` is ERROR 1064 there, while MySQL 8 and TiDB accept it and default
 * the host to `%`. Sharing one MySQL-family emitter is right for users and
 * wrong here, so the role reference is built separately.
 */
export function mysqlRoleRef(name: string, host: string | undefined, dialect: string): string {
  return dialect.toLowerCase() === 'mariadb' ? mysqlQuote(name) : mysqlAccount(name, host);
}

export function ident(name: string, dialect: string): string {
  return quoteSqlIdentifier(name, dialect);
}

export function finalizeGeneratedUserSql(
  statements: GeneratedStatement[],
  warnings: PermissionWarning[],
  emptyError: string
): GeneratedUserSql | { error: string } {
  if (statements.length === 0) {
    return { error: emptyError };
  }

  if (statements.some((s) => s.sql.includes(PASSWORD_PLACEHOLDER))) {
    warnings.push({
      level: 'danger',
      message:
        `Replace ${PASSWORD_PLACEHOLDER} with a real password before running this. Fox Schema ` +
        'never handles the password: it is not stored, sent anywhere, or kept in history.',
    });
  }

  return {
    statements,
    warnings,
    risk: statements.some((s) => s.risk === 'critical')
      ? 'critical'
      : statements.some((s) => s.risk === 'administrative')
        ? 'administrative'
        : 'elevated',
  };
}

/** Mutable emitter used by dialect modules while building one request. */
export function createUserSqlEmitter(request: UserRequest, dialect: string) {
  const name = request.name.trim();
  const isUser = request.principalType === 'user';
  const noun = isUser ? 'user' : 'role';
  const statements: GeneratedStatement[] = [];
  const warnings: PermissionWarning[] = [];

  const add = (sql: string, explanation: string, risk: PermissionRisk = 'elevated') =>
    statements.push({ sql, explanation, risk });

  const q = (v: string) => ident(v, dialect);

  const finish = () =>
    finalizeGeneratedUserSql(
      statements,
      warnings,
      `Nothing to do for this ${noun} on ${dialect}.`
    );

  return { name, isUser, noun, statements, warnings, add, q, finish };
}

/** Stub for engines with no SQL-reachable accounts. */
export function unsupportedUserSqlDialect(id: string): UserSqlDialect {
  const reason = nonSqlAccountsReason(id) ?? UNSUPPORTED_USER_SQL.reason!;
  return {
    id,
    support: { ...UNSUPPORTED_USER_SQL, reason },
    build() {
      return { error: reason };
    },
  };
}
