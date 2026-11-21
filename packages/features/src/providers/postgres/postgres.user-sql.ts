/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Postgres account DDL (CREATE/ALTER/DROP ROLE with LOGIN for users).
 */
import {
  PASSWORD_PLACEHOLDER,
  type UserRequest,
  type UserSqlDialect,
} from '../../modules/access/user-sql.types.js';
import { createUserSqlEmitter } from '../../modules/access/user-sql-helpers.js';
import type { PermissionRisk } from '../../modules/access/intent.js';
import type { PermissionWarning } from '../../modules/access/access-sql.types.js';

export const postgresUserSql: UserSqlDialect = {
  id: 'postgres',
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
        // LOGIN is what separates a user from a role — the two are one object type.
        add(
          `CREATE ROLE ${q(name)} WITH LOGIN PASSWORD '${PASSWORD_PLACEHOLDER}';`,
          `Creates ${name} and allows it to connect. In Postgres a user is a role with LOGIN.`
        );
      }
      return finish();
    }

    if (request.action === 'drop') {
      const risk: PermissionRisk = 'administrative';
      const keyword = isUser ? 'USER' : 'ROLE';
      // Without these, the drop below fails outright — including after this
      // tool's own read grant, which always emits GRANT USAGE ON SCHEMA.
      // Verified against PostgreSQL 16: create a role, grant it USAGE, and
      // DROP USER answers "cannot be dropped because some objects depend on
      // it".
      //
      // REASSIGN comes first and is what makes this safe. DROP OWNED BY on its
      // own *drops* the objects the role owns; reassigning them first leaves it
      // holding only privileges, so the same statement then removes those and
      // nothing else. Verified: a table owned by the role survives, transferred
      // to the current user.
      if (request.cascade) {
        add(
          `REASSIGN OWNED BY ${q(name)} TO CURRENT_USER;`,
          `Transfers anything ${name} owns to the role running this, so the next statement removes only privileges.`,
          'administrative'
        );
        add(
          `DROP OWNED BY ${q(name)};`,
          `Removes the privileges ${name} still holds in this database. Objects it owned are already reassigned.`,
          'administrative'
        );
      }
      add(
        `DROP ${keyword} ${q(name)};`,
        request.cascade
          ? `Drops the ${noun} ${name}, now that nothing depends on it.`
          : `Drops the ${noun} ${name}. This fails if it still owns objects or holds privileges.`,
        risk
      );
      warnings.push(
        request.cascade
          ? {
              level: 'caution',
              message:
                `REASSIGN OWNED BY transfers everything ${name} owns to whoever runs this, which changes ownership of real objects. ` +
                `Both it and DROP OWNED BY act on the current database only — repeat them in each database ${name} has touched.`,
            }
          : {
              level: 'caution',
              message:
                `Postgres refuses to drop ${name} while it owns objects or holds privileges — including the schema USAGE that a read grant gives it. ` +
                `Tick "drop owned objects" to generate the REASSIGN OWNED BY and DROP OWNED BY that clear the way.`,
            }
      );
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
    const keyword = isUser ? 'USER' : 'ROLE';
    add(
      `ALTER ${keyword} ${q(name)} RENAME TO ${q(next)};`,
      `Renames ${name} to ${next}. Privileges follow the account.`
    );
    // An MD5 hash is computed over the password *and* the role name, so renaming
    // invalidates it and PostgreSQL discards it — `NOTICE: MD5 password cleared
    // because of role rename`, after which the account cannot log in. SCRAM does
    // not bind the name, so a scram-sha-256 account keeps its password across a
    // rename. Both verified against PostgreSQL 16.
    //
    // Which one applies depends on the server's password_encryption at the time
    // the password was set, which is not knowable from here — so this says what
    // to check rather than asserting an outcome it cannot see.
    if (isUser) {
      warnings.push({
        level: 'caution',
        message:
          `If ${name}'s password is an MD5 hash, PostgreSQL clears it on rename and ${next} ` +
          'cannot log in until you set a new one. A scram-sha-256 password survives the rename. ' +
          `Check which with: SELECT left(rolpassword, 4) FROM pg_authid WHERE rolname = '${name}';`,
      });
    }
    return undefined;
  }

  if (change === 'password') {
    if (!isUser) return 'A role has no password.';
    add(
      `ALTER ROLE ${q(name)} WITH PASSWORD '${PASSWORD_PLACEHOLDER}';`,
      `Sets a new password for ${name}.`
    );
    return undefined;
  }

  if (change === 'expire') {
    if (!isUser) return 'A role has no expiry date.';
    if (!support.canExpire) {
      return `${dialect} cannot set account expiry in SQL.`;
    }
    const until = request.validUntil?.trim() || 'infinity';
    // VALID UNTIL takes a string literal — quote-escape so a crafted
    // date cannot close the literal and append another statement.
    const untilLiteral = until.replace(/'/g, "''");
    add(
      `ALTER ROLE ${q(name)} VALID UNTIL '${untilLiteral}';`,
      until === 'infinity'
        ? `Removes expiry for ${name}.`
        : `Refuses connections from ${name} after ${until}.`
    );
    return undefined;
  }

  if (!support.canDisable) {
    return `${dialect} cannot disable an account. Drop it, or revoke its privileges instead.`;
  }
  const disabling = change === 'disable';
  add(
    `ALTER ROLE ${q(name)} ${disabling ? 'NOLOGIN' : 'LOGIN'};`,
    disabling
      ? `Refuses new connections from ${name}. Existing sessions continue until they end.`
      : `Lets ${name} connect again.`
  );
  return undefined;
}
