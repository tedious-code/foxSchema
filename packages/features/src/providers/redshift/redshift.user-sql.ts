/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Redshift account DDL — GROUP instead of ROLE; CREATE/ALTER USER … PASSWORD.
 */
import {
  PASSWORD_PLACEHOLDER,
  type UserRequest,
  type UserSqlDialect,
} from '../../modules/access/user-sql.types.js';
import { createUserSqlEmitter } from '../../modules/access/user-sql-helpers.js';
import type { PermissionRisk } from '../../modules/access/intent.js';
import type { PermissionWarning } from '../../modules/access/access-sql.types.js';

export const redshiftUserSql: UserSqlDialect = {
  id: 'redshift',
  support: {
    supported: true,
    canCreateUser: true,
    canCreateRole: true,
    canDisable: true,
    canRename: true,
    canExpire: true,
  },

  build(request, dialect) {
    const { name, isUser, noun, add, q, finish, warnings } = createUserSqlEmitter(request, dialect);
    const support = this.support;

    if (request.action === 'create') {
      if (!isUser) {
        add(`CREATE GROUP ${q(name)};`, `Creates the group ${name}, which holds privileges.`);
      } else {
        add(
          `CREATE USER ${q(name)} PASSWORD '${PASSWORD_PLACEHOLDER}';`,
          `Creates ${name}.`
        );
      }
      return finish();
    }

    if (request.action === 'drop') {
      const risk: PermissionRisk = 'administrative';
      if (!isUser) {
        add(`DROP GROUP ${q(name)};`, `Drops the group ${name}.`, risk);
      } else {
        add(
          `DROP USER ${q(name)};`,
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
    if (!isUser) {
      return 'Redshift cannot rename a group. Create the new group and drop the old one.';
    }
    add(
      `ALTER USER ${q(name)} RENAME TO ${q(next)};`,
      `Renames ${name} to ${next}. Privileges follow the account, but the password does not.`
    );
    // Redshift encrypts a password with the user name as part of the input, so
    // renaming leaves the account with no password at all and it cannot log in
    // until one is set. Saying only "privileges follow the account" reads as
    // "nothing else changed", which is how a rename turns into a lockout
    // nobody expected. Documented under ALTER USER … RENAME TO.
    warnings.push({
      level: 'caution',
      message:
        `Redshift clears the password when an account is renamed, so ${next} cannot log in ` +
        'until you set one. Follow this with a password change.',
    });
    return undefined;
  }

  if (change === 'password') {
    if (!isUser) return 'A group has no password.';
    // Redshift has no ALTER ROLE — password changes are ALTER USER … PASSWORD.
    add(
      `ALTER USER ${q(name)} PASSWORD '${PASSWORD_PLACEHOLDER}';`,
      `Sets a new password for ${name}.`
    );
    return undefined;
  }

  if (change === 'expire') {
    if (!isUser) return 'A group has no expiry date.';
    if (!support.canExpire) {
      return `${dialect} cannot set account expiry in SQL.`;
    }
    const until = request.validUntil?.trim() || 'infinity';
    const untilLiteral = until.replace(/'/g, "''");
    // VALID UNTIL is a PASSWORD option on Redshift — set both together.
    add(
      `ALTER USER ${q(name)} PASSWORD '${PASSWORD_PLACEHOLDER}' VALID UNTIL '${untilLiteral}';`,
      until === 'infinity'
        ? `Sets a new password for ${name} with no expiry.`
        : `Sets a new password for ${name} that stops working after ${until}.`
    );
    return undefined;
  }

  if (!support.canDisable) {
    return `${dialect} cannot disable an account. Drop it, or revoke its privileges instead.`;
  }
  if (!isUser) return 'A group cannot be disabled; drop it or revoke its privileges instead.';
  const disabling = change === 'disable';
  if (disabling) {
    add(
      `ALTER USER ${q(name)} NOLOGIN;`,
      `Refuses new connections from ${name}.`
    );
  } else {
    add(
      `ALTER USER ${q(name)} LOGIN PASSWORD '${PASSWORD_PLACEHOLDER}';`,
      `Lets ${name} connect again. Set a password when re-enabling login.`
    );
  }
  return undefined;
}
