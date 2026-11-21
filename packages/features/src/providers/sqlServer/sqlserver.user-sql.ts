/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SQL Server / Azure SQL account DDL — LOGIN (server) + USER (database).
 */
import {
  PASSWORD_PLACEHOLDER,
  type UserRequest,
  type UserSqlDialect,
} from '../../modules/access/user-sql.types.js';
import { createUserSqlEmitter } from '../../modules/access/user-sql-helpers.js';
import type { PermissionRisk } from '../../modules/access/intent.js';
import type { PermissionWarning } from '../../modules/access/access-sql.types.js';

export const sqlServerUserSql: UserSqlDialect = {
  id: 'sqlserver',
  support: {
    supported: true,
    canCreateUser: true,
    canCreateRole: true,
    canDisable: true,
    canRename: true,
    canExpire: true,
  },

  build(request, dialect) {
    const { name, isUser, noun, warnings, add, q, finish } = createUserSqlEmitter(
      request,
      dialect
    );
    const support = this.support;

    if (request.action === 'create') {
      if (!isUser) {
        add(
          `CREATE ROLE ${q(name)};`,
          `Creates the role ${name}. A role holds privileges; grant it to users afterwards.`
        );
      } else {
        // A login authenticates to the server; a user maps it into this
        // database. One without the other cannot connect and use data.
        add(
          `CREATE LOGIN ${q(name)} WITH PASSWORD = '${PASSWORD_PLACEHOLDER}';`,
          `Creates the server login ${name}. Run this against the master database.`
        );
        add(
          `CREATE USER ${q(name)} FOR LOGIN ${q(name)};`,
          `Maps the login into this database as ${name}. Run this against the database itself.`
        );
        warnings.push({
          level: 'info',
          message:
            'SQL Server needs both: the login belongs to the server (master) and the user to ' +
            'this database. Run them against the right database each.',
        });
      }
      return finish();
    }

    if (request.action === 'drop') {
      const risk: PermissionRisk = 'administrative';
      if (isUser) {
        // Catalog lists database users only. Login names often differ
        // (`CREATE USER app FOR LOGIN corp_app`), so auto-emitting
        // `DROP LOGIN [app]` can delete an unrelated server login.
        add(`DROP USER ${q(name)};`, `Removes ${name} from this database.`, risk);
        warnings.push({
          level: 'caution',
          message:
            `Only the database user is dropped. If a server login should go too, drop it ` +
            `explicitly against master after confirming its name (it may differ from ${name}).`,
        });
      } else {
        add(
          `DROP ROLE ${q(name)};`,
          `Drops the ${noun} ${name}. Privileges granted to it are removed with it.`,
          risk
        );
      }
      return finish();
    }

    const failed = buildAlter(request, dialect, name, isUser, support, add, q, warnings);
    if (failed) return { error: failed };
    return finish();
  },
};

function buildAlter(
  request: UserRequest,
  dialect: string,
  name: string,
  isUser: boolean,
  support: UserSqlDialect['support'],
  add: (sql: string, explanation: string, risk?: PermissionRisk) => void,
  q: (v: string) => string,
  warnings: PermissionWarning[]
): string | undefined {
  const change = request.alteration ?? 'password';

  if (change === 'rename') {
    const next = request.newName?.trim();
    if (!next) return 'Enter the new name.';
    if (!support.canRename) {
      return `${dialect} cannot rename an account. Create the new one and drop the old.`;
    }
    add(
      `ALTER USER ${q(name)} WITH NAME = ${q(next)};`,
      `Renames ${name} to ${next}. Privileges follow the account.`
    );
    return undefined;
  }

  // Password / expiry / disable live on the server LOGIN. The catalog only
  // lists database users — LOGIN names often differ (`CREATE USER app FOR
  // LOGIN corp_app`). Emitting `ALTER LOGIN [app]` can change or lock an
  // unrelated server login. Same rule as drop: never guess LOGIN from USER.
  const loginCaution = {
    level: 'caution' as const,
    message:
      `Password, expiry and disable apply to the server LOGIN, which may differ from ` +
      `database user ${name}. Confirm the login name (for example from sys.server_principals), ` +
      `replace <login_name>, then run against master.`,
  };

  if (change === 'password') {
    if (!isUser) return 'A role has no password.';
    add(
      `-- Password lives on the server LOGIN, which may not match database user ${q(name)}.\n` +
        `-- Confirm the login name, then run against master:\n` +
        `-- ALTER LOGIN <login_name> WITH PASSWORD = '${PASSWORD_PLACEHOLDER}';`,
      `Template to set a new password once you confirm the LOGIN for ${name}.`,
      'elevated'
    );
    warnings.push(loginCaution);
    return undefined;
  }

  if (change === 'expire') {
    if (!isUser) return 'A role has no expiry date.';
    if (!support.canExpire) {
      return `${dialect} cannot set account expiry in SQL.`;
    }
    add(
      `-- Expiry is enforced on the server LOGIN, which may not match database user ${q(name)}.\n` +
        `-- Confirm the login name, then run against master:\n` +
        `-- ALTER LOGIN <login_name> WITH CHECK_EXPIRATION ON;`,
      `Template to require password expiry once you confirm the LOGIN for ${name}.`,
      'elevated'
    );
    warnings.push(loginCaution);
    return undefined;
  }

  if (!support.canDisable) {
    return `${dialect} cannot disable an account. Drop it, or revoke its privileges instead.`;
  }
  const disabling = change === 'disable';
  add(
    `-- Enable/disable is a server LOGIN setting, which may not match database user ${q(name)}.\n` +
      `-- Confirm the login name, then run against master:\n` +
      `-- ALTER LOGIN <login_name> ${disabling ? 'DISABLE' : 'ENABLE'};`,
    disabling
      ? `Template to refuse new connections once you confirm the LOGIN for ${name}.`
      : `Template to allow connections again once you confirm the LOGIN for ${name}.`,
    'elevated'
  );
  warnings.push(loginCaution);
  return undefined;
}
