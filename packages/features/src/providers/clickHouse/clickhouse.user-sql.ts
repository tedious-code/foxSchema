/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * ClickHouse account DDL.
 */
import {
  PASSWORD_PLACEHOLDER,
  type UserRequest,
  type UserSqlDialect,
} from '../../modules/access/user-sql.types.js';
import { createUserSqlEmitter } from '../../modules/access/user-sql-helpers.js';
import type { PermissionRisk } from '../../modules/access/intent.js';

export const clickHouseUserSql: UserSqlDialect = {
  id: 'clickhouse',
  support: {
    supported: true,
    canCreateUser: true,
    canCreateRole: true,
    canDisable: false,
    canRename: true,
    canExpire: false,
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
          `CREATE USER ${q(name)} IDENTIFIED WITH sha256_password BY '${PASSWORD_PLACEHOLDER}';`,
          `Creates ${name}.`
        );
      }
      return finish();
    }

    if (request.action === 'drop') {
      const risk: PermissionRisk = 'administrative';
      const keyword = isUser ? 'USER' : 'ROLE';
      add(
        `DROP ${keyword} ${q(name)};`,
        `Drops the ${noun} ${name}. Privileges granted to it are removed with it.`,
        risk
      );
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
    const keyword = isUser ? 'USER' : 'ROLE';
    add(
      `ALTER ${keyword} ${q(name)} RENAME TO ${q(next)};`,
      `Renames ${name} to ${next}. Privileges follow the account.`
    );
    return undefined;
  }

  if (change === 'password') {
    if (!isUser) return 'A role has no password.';
    add(
      `ALTER USER ${q(name)} IDENTIFIED WITH sha256_password BY '${PASSWORD_PLACEHOLDER}';`,
      `Sets a new password for ${name}.`
    );
    return undefined;
  }

  if (change === 'expire') {
    if (!isUser) return 'A role has no expiry date.';
    return `${dialect} cannot set account expiry in SQL.`;
  }

  return `${dialect} cannot disable an account. Drop it, or revoke its privileges instead.`;
}
