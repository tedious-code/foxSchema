/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MySQL / MariaDB / TiDB account DDL (`user`@`host`).
 */
import {
  PASSWORD_PLACEHOLDER,
  type UserRequest,
  type UserSqlDialect,
} from '../../modules/access/user-sql.types.js';
import {
  createUserSqlEmitter,
  mysqlAccount,
  mysqlRoleRef,
} from '../../modules/access/user-sql-helpers.js';
import type { PermissionRisk } from '../../modules/access/intent.js';

export const mysqlUserSql: UserSqlDialect = {
  id: 'mysql',
  support: {
    supported: true,
    canCreateUser: true,
    canCreateRole: true,
    canDisable: true,
    canRename: true,
    canExpire: true,
  },

  build(request, dialect) {
    const { name, isUser, noun, add, finish } = createUserSqlEmitter(request, dialect);
    const support = this.support;
    const account = mysqlAccount(name, request.host);
    // A role is not host-qualified on MariaDB, and saying so is a syntax error.
    const roleRef = mysqlRoleRef(name, request.host, dialect);

    if (request.action === 'create') {
      if (!isUser) {
        add(
          `CREATE ROLE ${roleRef};`,
          `Creates the role ${name}. A role holds privileges; grant it to users afterwards.`
        );
      } else {
        add(
          `CREATE USER ${account} IDENTIFIED BY '${PASSWORD_PLACEHOLDER}';`,
          `Creates ${name}, able to connect from ${request.host?.trim() || '%'}.`
        );
      }
      return finish();
    }

    if (request.action === 'drop') {
      const risk: PermissionRisk = 'administrative';
      const keyword = isUser ? 'USER' : 'ROLE';
      add(
        `DROP ${keyword} ${isUser ? account : roleRef};`,
        `Drops the ${noun} ${name}. Privileges granted to it are removed with it.`,
        risk
      );
      return finish();
    }

    const failed = buildAlter(request, dialect, name, isUser, account, support, add);
    if (failed) return { error: failed };
    return finish();
  },
};

function buildAlter(
  request: UserRequest,
  dialect: string,
  name: string,
  isUser: boolean,
  account: string,
  support: UserSqlDialect['support'],
  add: (sql: string, explanation: string, risk?: PermissionRisk) => void
): string | undefined {
  const change = request.alteration ?? 'password';

  if (change === 'rename') {
    const next = request.newName?.trim();
    if (!next) return 'Enter the new name.';
    if (!support.canRename) {
      return `${dialect} cannot rename an account. Create the new one and drop the old.`;
    }
    if (!isUser && dialect.toLowerCase() === 'mariadb') {
      // RENAME USER is the only rename MariaDB has, and it refuses a role
      // (ERROR 1396). Emitting it would hand over a statement that cannot work.
      return 'MariaDB cannot rename a role. Create the new role, grant it the same privileges, then drop the old one.';
    }
    add(
      `RENAME USER ${account} TO ${mysqlAccount(next, request.host)};`,
      `Renames ${name} to ${next}. Privileges follow the account.`
    );
    return undefined;
  }

  if (change === 'password') {
    if (!isUser) return 'A role has no password.';
    add(
      `ALTER USER ${account} IDENTIFIED BY '${PASSWORD_PLACEHOLDER}';`,
      `Sets a new password for ${name}.`
    );
    return undefined;
  }

  if (change === 'expire') {
    if (!isUser) return 'A role has no expiry date.';
    if (!support.canExpire) {
      return `${dialect} cannot set account expiry in SQL.`;
    }
    const days = request.validUntil?.trim();
    // Interval is unquoted SQL — only a non-negative integer is safe.
    if (days && !/^\d+$/.test(days)) {
      return 'Enter the expiry interval as a number of days (for example 90).';
    }
    add(
      days
        ? `ALTER USER ${account} PASSWORD EXPIRE INTERVAL ${days} DAY;`
        : `ALTER USER ${account} PASSWORD EXPIRE;`,
      days
        ? `Forces ${name} to change password within ${days} days.`
        : `Forces ${name} to change password on next login.`
    );
    return undefined;
  }

  if (!support.canDisable) {
    return `${dialect} cannot disable an account. Drop it, or revoke its privileges instead.`;
  }
  const disabling = change === 'disable';
  add(
    `ALTER USER ${account} ACCOUNT ${disabling ? 'LOCK' : 'UNLOCK'};`,
    disabling
      ? `Refuses new connections from ${name}. The account and its privileges stay.`
      : `Lets ${name} connect again.`
  );
  return undefined;
}
