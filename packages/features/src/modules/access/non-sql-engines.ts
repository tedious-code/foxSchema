/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engines whose accounts and permissions are real, but not reachable through
 * SQL — so Fox Schema refuses, and says where to go instead.
 *
 * There are two different reasons a screen here can have nothing to offer, and
 * conflating them misinforms the reader about their own server:
 *
 *   - The engine has no such concept. SQLite and DuckDB have no accounts and
 *     no grants; the file's owner is the access control. "Nothing to manage"
 *     is the whole truth.
 *   - The engine has one, in a language this module does not speak. Redis and
 *     MongoDB both have full account *and* permission systems. Telling those
 *     readers their database has none is simply false.
 *
 * Everything named below was run against Redis 7.4 and MongoDB 7 rather than
 * read off a page, because a refusal that names a command is only better than
 * silence if the command works:
 *
 *   Redis    ACL SETUSER foxum on >pw ~fox:* +get   created the account; then
 *            GET fox:demo:name returned the value, GET other:key was refused
 *            with NOPERM on the key, and DEL was refused with NOPERM on the
 *            command — so key patterns and command lists are the permission
 *            model, both set by that one command. `resetpass` changed the
 *            password (the old one then gave WRONGPASS), `off`/`on` disabled
 *            and re-enabled it, and ACL DELUSER removed it. ACL WHOAMI
 *            confirmed each result, since a failed AUTH leaves the connection
 *            on `default` rather than closing it.
 *
 *   MongoDB  db.createUser with a `read` role read a collection and was denied
 *            an insert; db.grantRolesToUser with `readWrite` then allowed the
 *            same insert. db.changeUserPassword invalidated the old password,
 *            db.dropUser ended authentication entirely.
 *
 * Two gaps found the same way, kept out of the messages so they promise only
 * what exists: neither engine can rename an account (`ACL SETUSER … RENAME` is
 * a syntax error; MongoDB has `no such command: 'renameUser'`), and MongoDB
 * cannot disable one — its whole user command list is createUser, dropUser,
 * grantRolesToUser, revokeRolesFromUser, updateUser and usersInfo. Revoking
 * every role leaves the account able to authenticate, just unable to do
 * anything, which is not the same thing and should not be called disabling.
 */

export interface NonSqlAccessModel {
  /** The client that does speak this engine's account language. */
  tool: string;
  /** Commands that manage accounts. */
  accounts: string;
  /** Commands that manage permissions. */
  permissions: string;
}

const NON_SQL_ACCESS: Record<string, NonSqlAccessModel> = {
  redis: {
    tool: 'redis-cli',
    accounts: 'ACL SETUSER, ACL LIST',
    // Key patterns (~fox:*) and command lists (+get) are the permission model,
    // and both are arguments to the same command that makes the account.
    permissions: 'ACL SETUSER with key patterns and command lists',
  },
  mongodb: {
    tool: 'mongosh',
    accounts: 'db.createUser, db.grantRolesToUser',
    permissions: 'db.grantRolesToUser, db.revokeRolesFromUser',
  },
};

export function nonSqlAccessModel(dialect: string): NonSqlAccessModel | undefined {
  return NON_SQL_ACCESS[(dialect || '').toLowerCase()];
}

/** Proper name for a message, since `mongodb` in a sentence reads as a typo. */
const DISPLAY: Record<string, string> = { redis: 'Redis', mongodb: 'MongoDB' };

export function displayEngineName(dialect: string): string {
  return DISPLAY[(dialect || '').toLowerCase()] ?? dialect;
}

/**
 * Why account management is unavailable, in this engine's own terms.
 *
 * Returns undefined for an engine that genuinely has no accounts, so the
 * caller keeps its plain wording rather than inventing a tool to name.
 */
export function nonSqlAccountsReason(dialect: string): string | undefined {
  const model = nonSqlAccessModel(dialect);
  if (!model) return undefined;
  const name = displayEngineName(dialect);
  return (
    `Fox Schema does not manage ${name} accounts. ${name} has them — ${model.accounts} — ` +
    `but they are not reachable through SQL, so use ${model.tool}.`
  );
}

/**
 * The same, for the permission builder.
 *
 * Kept beside the account message on purpose. They were written apart and
 * drifted: the account screen named the tool while the permission screen said
 * only that Fox Schema had no model, which is where a Redis or MongoDB reader
 * most needs the pointer — the permission system is the interesting half of
 * both engines.
 */
export function nonSqlPermissionsReason(dialect: string): string | undefined {
  const model = nonSqlAccessModel(dialect);
  if (!model) return undefined;
  const name = displayEngineName(dialect);
  return (
    `Fox Schema does not build ${name} permissions. ${name} has them — ${model.permissions} — ` +
    `but they are not SQL grants, so use ${model.tool}.`
  );
}
