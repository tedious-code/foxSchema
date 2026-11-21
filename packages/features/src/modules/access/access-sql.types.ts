/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared types for GRANT/REVOKE SQL. Dialect modules import from here, not
 * from `access-sql.ts`, so the registry can load them without a cycle.
 */
import type { AccessPermission, PermissionRequest, PermissionRisk } from './intent.js';

export interface GeneratedStatement {
  sql: string;
  /** What this one line does, in the reader's terms. */
  explanation: string;
  risk: PermissionRisk;
}

export type AccessWarningLevel = 'info' | 'caution' | 'danger';

export interface PermissionWarning {
  level: AccessWarningLevel;
  message: string;
}

export interface GeneratedPermissionSql {
  statements: GeneratedStatement[];
  warnings: PermissionWarning[];
  /** Worst risk across the statements, for a summary badge. */
  risk: PermissionRisk;
}

export interface EmitCtx {
  request: PermissionRequest;
  dialect: string;
  grantee: string;
  ident: (n: string) => string;
  verb: string;
  dir: string;
  option: string;
  add: (
    sql: string,
    explanation: string,
    risk: PermissionRisk,
    covers?: readonly AccessPermission[]
  ) => void;
}

/**
 * One engine's GRANT/REVOKE emitter. Not on `SqlDialect` (migration DDL) and
 * not mixed into `UserSqlDialect` (account DDL).
 */
export interface AccessSqlDialect {
  readonly id: string;
  emit(ctx: EmitCtx): void;
}
