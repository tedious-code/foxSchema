/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Types and public constants for account DDL. Dialects implement
 * {@link UserSqlDialect}; the facade in `user-sql.ts` dispatches to them.
 */
import type { PermissionRisk } from './intent.js';
import type { GeneratedStatement, PermissionWarning } from './access-sql.types.js';

/** What the caller is operating on. */
export type PrincipalType = 'user' | 'role';

export type UserAction = 'create' | 'alter' | 'drop';

/** The change an `alter` is asking for. */
export type UserAlteration =
  /** Set a new password. */
  | 'password'
  /** Rename the account. */
  | 'rename'
  /** Refuse new connections without dropping anything. */
  | 'disable'
  /** Join or leave roles and groups. */
  | 'membership'
  /** Allow connections again. */
  | 'enable'
  /** Force password change or set account expiry. */
  | 'expire';

export interface UserRequest {
  action: UserAction;
  principalType: PrincipalType;
  /** The account being created, altered or dropped. */
  name: string;
  /** For `alter` + `rename`. */
  newName?: string;
  /** For `alter`: which change. Ignored for create and drop. */
  alteration?: UserAlteration;
  /**
   * For `alter` + `expire`: ISO date (Postgres VALID UNTIL) or interval like
   * `90` days for MySQL PASSWORD EXPIRE INTERVAL.
   */
  validUntil?: string;
  /**
   * MySQL-family host part, e.g. `%` or `localhost`. A MySQL account is
   * identified by user *and* host, so the wrong host is a different account.
   */
  host?: string;
  /** Drop objects the account owns as well. Oracle needs this to drop at all. */
  cascade?: boolean;
  /**
   * For `create`: existing roles or groups to put the new account in. Each
   * becomes a GRANT after the CREATE, so an account can be made and placed in
   * one review instead of two trips through two screens.
   */
  roles?: string[];
  /** For `alter` + `membership`: roles or groups to join. */
  rolesToAdd?: string[];
  /** For `alter` + `membership`: roles or groups to leave. */
  rolesToRemove?: string[];
}

export interface GeneratedUserSql {
  statements: GeneratedStatement[];
  warnings: PermissionWarning[];
  risk: PermissionRisk;
}

/**
 * Stands in for a real password, which this module never sees.
 *
 * Defined in `sql-text` so `command-mode` can use it too without importing
 * this domain — see the note there.
 */
export { PASSWORD_PLACEHOLDER } from '../sql-text/password-placeholder.js';

export interface UserManagementSupport {
  /** False when the engine has no SQL-reachable accounts at all. */
  supported: boolean;
  /** False when the engine has users but they cannot be created in SQL. */
  canCreateUser: boolean;
  canCreateRole: boolean;
  /** True where an account may be disabled instead of dropped. */
  canDisable: boolean;
  canRename: boolean;
  /** True where password or account expiry can be set in SQL. */
  canExpire: boolean;
  /** Shown when something is unavailable, so the UI can say why. */
  reason?: string;
}

/**
 * Per-engine account DDL strategy. Lives next to migration dialects under
 * `packages/sql/src/providers/<name>/<name>.user-sql.ts` (pure SQL generation —
 * not in `@foxschema/db`, which is Node drivers only and not browser-safe).
 */
export interface UserSqlDialect {
  readonly id: string;
  readonly support: UserManagementSupport;
  build(request: UserRequest, dialect: string): GeneratedUserSql | { error: string };
}
