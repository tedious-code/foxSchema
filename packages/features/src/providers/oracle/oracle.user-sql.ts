/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Oracle account DDL — CREATE USER + GRANT CREATE SESSION; optional CASCADE drop.
 */
import {
  PASSWORD_PLACEHOLDER,
  type UserRequest,
  type UserSqlDialect,
} from '../../modules/access/user-sql.types.js';
import { createUserSqlEmitter } from '../../modules/access/user-sql-helpers.js';
import type { PermissionRisk } from '../../modules/access/intent.js';

export const oracleUserSql: UserSqlDialect = {
  id: 'oracle',
  support: {
    supported: true,
    canCreateUser: true,
    canCreateRole: true,
    canDisable: true,
    canRename: false,
    canExpire: true,
  },

  build(request, dialect) {
    const { name, isUser, noun, add, q, finish } = createUserSqlEmitter(request, dialect);
    const support = this.support;

    if (request.action === 'create') {
      if (!isUser) {
        add(
          `CREATE ROLE ${q(name)};`,
          `Creates the role ${name}. A role holds privileges; grant it to users afterwards.`
        );
      } else {
        add(
          `CREATE USER ${q(name)} IDENTIFIED BY "${PASSWORD_PLACEHOLDER}";`,
          `Creates ${name}.`
        );
        add(
          `GRANT CREATE SESSION TO ${q(name)};`,
          'Without CREATE SESSION the account exists but cannot log in.'
        );
      }
      return finish();
    }

    if (request.action === 'drop') {
      const risk: PermissionRisk = 'administrative';
      if (isUser) {
        // Oracle refuses to drop a user that owns anything, so the choice has to
        // be explicit rather than silently appended.
        add(
          `DROP USER ${q(name)}${request.cascade ? ' CASCADE' : ''};`,
          request.cascade
            ? `Drops ${name} and every object it owns. The objects are not recoverable.`
            : `Drops ${name}. Oracle refuses this while the account owns any object — use CASCADE to drop those too.`,
          request.cascade ? 'critical' : risk
        );
      } else {
        add(
          `DROP ROLE ${q(name)};`,
          `Drops the ${noun} ${name}. Privileges granted to it are removed with it.`,
          risk
        );
      }
      return finish();
    }

    const failed = buildAlter(request, dialect, name, isUser, support, add, q);
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
  q: (v: string) => string
): string | undefined {
  const change = request.alteration ?? 'password';

  if (change === 'rename') {
    const next = request.newName?.trim();
    if (!next) return 'Enter the new name.';
    if (!support.canRename) {
      return `${dialect} cannot rename an account. Create the new one and drop the old.`;
    }
    return undefined;
  }

  if (change === 'password') {
    if (!isUser) return 'A role has no password.';
    add(
      `ALTER USER ${q(name)} IDENTIFIED BY "${PASSWORD_PLACEHOLDER}";`,
      `Sets a new password for ${name}.`
    );
    return undefined;
  }

  if (change === 'expire') {
    if (!isUser) return 'A role has no expiry date.';
    if (!support.canExpire) {
      return `${dialect} cannot set account expiry in SQL.`;
    }
    add(
      `ALTER USER ${q(name)} PASSWORD EXPIRE;`,
      `Forces ${name} to change password on next login.`
    );
    return undefined;
  }

  if (!support.canDisable) {
    return `${dialect} cannot disable an account. Drop it, or revoke its privileges instead.`;
  }
  const disabling = change === 'disable';
  add(
    `ALTER USER ${q(name)} ACCOUNT ${disabling ? 'LOCK' : 'UNLOCK'};`,
    disabling ? `Refuses new connections from ${name}.` : `Lets ${name} connect again.`
  );
  return undefined;
}
