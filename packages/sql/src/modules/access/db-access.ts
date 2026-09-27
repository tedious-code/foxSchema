/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dialect-aware catalog probes and GRANT/REVOKE SQL for SQL Editor →
 * Database Access (also embedded in Access control).
 *
 * Quality ladder mirrors index fragmentation: native catalogs when available,
 * a simpler information_schema fallback next, unsupported for engines with no
 * GRANT (SQLite / DuckDB).
 */

import { quoteSqlIdentifier } from '../sql-text/sql-template.js';
import { accessFamily } from './intent.js';
import { mysqlAccount, mysqlQuote, mysqlRoleRef } from './user-sql-helpers.js';

export type DbAccessProbeMode = 'native' | 'estimated' | 'unsupported';

export interface DbAccessSupport {
  mode: DbAccessProbeMode;
  query: boolean;
  grant: boolean;
  hint: string;
}

export interface DbAccessQuery {
  sql: string;
  params: unknown[];
}

export type DbPrincipalKind = 'user' | 'role' | 'group';

export interface DbPrincipal {
  name: string;
  kind: DbPrincipalKind;
  canLogin: boolean | null;
  /** Roles/groups this principal belongs to. */
  memberOf: string[];
  /** Members when this principal is a role/group. */
  members: string[];
  /**
   * Bypasses every permission check (Postgres `rolsuper`, SQL Server
   * `sysadmin`). An account attribute, not a grant, so it never appears in the
   * privilege list — which is how a superuser came to read as "no privileges".
   * Absent or null where the engine has no such flag or the catalog does not say.
   */
  superuser?: boolean | null;
}

/**
 * `GLOBAL` is instance-wide: MySQL-family and ClickHouse `ON *.*`. `SYSTEM` is
 * an engine authority that takes no object (Oracle system privileges, Db2
 * database authorities).
 */
export type DbPrivilegeObjectType =
  | 'TABLE'
  | 'SCHEMA'
  | 'DATABASE'
  | 'GLOBAL'
  | 'ROLE'
  | 'SYSTEM'
  | 'COLUMN'
  | 'OTHER';

export interface DbPrivilege {
  grantee: string;
  privilege: string;
  objectType: DbPrivilegeObjectType;
  objectSchema: string | null;
  objectName: string | null;
  grantable: boolean;
  grantor: string | null;
  /** SQL Server DENY vs GRANT. Null on engines without DENY. */
  state: 'grant' | 'deny' | null;
  /**
   * Absent for a row the catalog returned. `derived`: a role membership filled
   * in from the other catalog (see `reconcileDbAccess`). `implied`: what a
   * fixed role confers without any row saying so (SQL Server `db_owner`).
   */
  source?: 'derived' | 'implied';
}

export interface DbAccessGrantArgs {
  dialect: string;
  action: 'grant' | 'revoke';
  privilege: string;
  objectType: DbPrivilegeObjectType | string;
  objectSchema?: string | null;
  objectName?: string | null;
  grantee: string;
  granteeKind?: DbPrincipalKind;
  withGrantOption?: boolean;
}

export const DB_OBJECT_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REFERENCES',
  'USAGE',
  'EXECUTE',
  'ALL',
] as const;

const UNSUPPORTED: DbAccessSupport = {
  mode: 'unsupported',
  query: false,
  grant: false,
  hint: 'This dialect has no GRANT/REVOKE catalog — access is file- or engine-level.',
};

/**
 * One family map for both access surfaces — this used to be a second copy of
 * `accessFamily`, which is exactly how two views of the same engine drift.
 */
const family = accessFamily;

const SUPPORT: Record<string, DbAccessSupport> = {
  postgres: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'PostgreSQL: pg_roles (with superuser) / pg_auth_members, table grants, and schema and database ACLs.',
  },
  cockroachdb: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'CockroachDB: PostgreSQL-compatible role and privilege catalogs.',
  },
  yugabytedb: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'YugabyteDB: PostgreSQL-compatible role and privilege catalogs.',
  },
  redshift: {
    mode: 'estimated',
    query: true,
    grant: true,
    hint: 'Redshift: pg_roles plus information_schema grants (some system grants are hidden).',
  },
  mysql: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'MySQL: mysql.user / mysql.role_edges and INFORMATION_SCHEMA USER/SCHEMA/TABLE_PRIVILEGES (including *.*).',
  },
  mariadb: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'MariaDB: mysql.user / mysql.roles_mapping and INFORMATION_SCHEMA USER/SCHEMA/TABLE_PRIVILEGES (including *.*).',
  },
  tidb: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'TiDB: MySQL-compatible user and privilege catalogs.',
  },
  sqlserver: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'SQL Server: sys.database_principals (with sysadmin), database_role_members, database_permissions, and what fixed roles imply.',
  },
  azuresql: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'Azure SQL: same database principal and permission views as SQL Server.',
  },
  oracle: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'Oracle: DBA_USERS / DBA_ROLES / DBA_TAB_PRIVS (falls back to ALL_*).',
  },
  db2: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'Db2: SYSCAT.ROLES, ROLEAUTH, TABAUTH.',
  },
  clickhouse: {
    mode: 'native',
    query: true,
    grant: true,
    hint: 'ClickHouse: system.users, system.roles, system.role_grants, system.grants.',
  },
  sqlite: UNSUPPORTED,
  duckdb: UNSUPPORTED,
};

export function dialectSupportsDbAccess(dialect: string): DbAccessSupport {
  return SUPPORT[family(dialect)] ?? {
    mode: 'estimated',
    query: true,
    grant: true,
    hint: 'Generic information_schema.TABLE_PRIVILEGES probe. GRANT SQL uses quoted identifiers.',
  };
}

/** Ordered catalog probes — backend tries each until one succeeds. */
export function buildDbAccessPrincipalQueries(opts: {
  dialect: string;
  schema?: string;
}): DbAccessQuery[] {
  const fam = family(opts.dialect);
  if (fam === 'postgres') {
    // rolsuper is in every Postgres-family pg_roles we target; the second probe
    // keeps an engine without it listing its roles rather than nothing.
    return [{ sql: PG_PRINCIPALS, params: [] }, { sql: PG_PRINCIPALS_NO_SUPERUSER, params: [] }];
  }
  if (fam === 'mysql') {
    return [
      { sql: MYSQL_PRINCIPALS, params: [] },
      // MySQL 5.7 has no mysql.role_edges, and so no roles.
      { sql: MYSQL_PRINCIPALS_NO_ROLES, params: [] },
      { sql: MYSQL_PRINCIPALS_FALLBACK, params: [] },
    ];
  }
  if (fam === 'mariadb') {
    return [
      { sql: MARIADB_PRINCIPALS, params: [] },
      { sql: MYSQL_PRINCIPALS_NO_ROLES, params: [] },
      { sql: MYSQL_PRINCIPALS_FALLBACK, params: [] },
    ];
  }
  if (fam === 'sqlserver') {
    // Azure SQL Database, or a login that may not ask about server roles, falls
    // back to the database-only form.
    return [{ sql: MSSQL_PRINCIPALS, params: [] }, { sql: MSSQL_PRINCIPALS_NO_SERVER, params: [] }];
  }
  if (fam === 'oracle') {
    return [{ sql: ORACLE_PRINCIPALS_DBA, params: [] }, { sql: ORACLE_PRINCIPALS_ALL, params: [] }];
  }
  if (fam === 'db2') {
    return [
      { sql: DB2_PRINCIPALS, params: [] },
      { sql: DB2_PRINCIPALS_ROLES, params: [] },
    ];
  }
  if (fam === 'clickhouse') {
    return [
      { sql: CLICKHOUSE_PRINCIPALS, params: [] },
      { sql: CLICKHOUSE_PRINCIPALS_NO_ROLE_GRANTS, params: [] },
    ];
  }
  return [{ sql: GENERIC_PRINCIPALS, params: [] }];
}

export function buildDbAccessPrivilegeQueries(opts: {
  dialect: string;
  schema?: string;
}): DbAccessQuery[] {
  const fam = family(opts.dialect);
  const schema = (opts.schema ?? '').trim();
  if (fam === 'postgres') {
    // aclexplode reads schema and database ACLs; an engine without it still
    // gets table grants and memberships from the information_schema form.
    return [{ sql: PG_PRIVILEGES, params: [] }, { sql: PG_PRIVILEGES_NO_ACL, params: [] }];
  }
  if (fam === 'mysql' || fam === 'mariadb') {
    // Most complete first. A login that may not read mysql.* loses the role
    // rows only; global grants come from information_schema, which every
    // login may read (it shows each its own).
    const ladder = (filter: boolean): DbAccessQuery[] =>
      [
        mysqlPrivilegesQuery({ schemaFilter: filter, global: true, roles: fam }),
        mysqlPrivilegesQuery({ schemaFilter: filter, global: true, roles: null }),
        mysqlPrivilegesQuery({ schemaFilter: filter, global: false, roles: null }),
      ].map((sql) => ({ sql, params: filter ? [schema, schema] : [] }));
    return schema ? [...ladder(true), ...ladder(false)] : ladder(false);
  }
  if (fam === 'sqlserver') return [{ sql: MSSQL_PRIVILEGES, params: [] }];
  if (fam === 'oracle') {
    return [{ sql: ORACLE_PRIVILEGES_DBA, params: [] }, { sql: ORACLE_PRIVILEGES_ALL, params: [] }];
  }
  if (fam === 'db2') return [{ sql: DB2_PRIVILEGES, params: [] }];
  if (fam === 'clickhouse') return [{ sql: CLICKHOUSE_PRIVILEGES, params: [] }];
  return [{ sql: GENERIC_PRIVILEGES, params: [] }];
}

export function normalizeDbPrincipals(rows: ReadonlyArray<Record<string, unknown>>): DbPrincipal[] {
  const out: DbPrincipal[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = stripQuotes(asString(pick(row, 'name', 'rolname', 'username', 'user_name', 'grantee')));
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      kind: normalizeKind(pick(row, 'kind', 'type_desc', 'type', 'granteetype')),
      canLogin: asBool(pick(row, 'can_login', 'rolcanlogin', 'canlogin')),
      memberOf: splitList(asString(pick(row, 'member_of', 'memberof'))),
      members: splitList(asString(pick(row, 'members', 'member'))),
      superuser: asBool(pick(row, 'superuser', 'rolsuper', 'is_superuser')),
    });
  }
  return out;
}

export function normalizeDbPrivileges(rows: ReadonlyArray<Record<string, unknown>>): DbPrivilege[] {
  const out: DbPrivilege[] = [];
  for (const row of rows) {
    const grantee = stripQuotes(asString(pick(row, 'grantee', 'user_name', 'role_name', 'grantee_name')));
    const privilege = asString(pick(row, 'privilege', 'privilege_type', 'permission_name', 'access_type', 'granted_role'));
    if (!grantee || !privilege) continue;
    const stateRaw = asString(pick(row, 'state', 'state_desc')).toLowerCase();
    out.push({
      grantee,
      privilege,
      objectType: normalizeObjectType(pick(row, 'object_type', 'class_desc', 'objecttype')),
      objectSchema: emptyToNull(asString(pick(row, 'object_schema', 'table_schema', 'owner', 'database', 'tabschema'))),
      objectName: emptyToNull(asString(pick(row, 'object_name', 'table_name', 'tabname', 'table'))),
      grantable: asBool(pick(row, 'grantable', 'is_grantable', 'grant_option', 'admin_option')) === true,
      grantor: emptyToNull(stripQuotes(asString(pick(row, 'grantor')))),
      state: stateRaw.includes('deny') ? 'deny' : stateRaw ? 'grant' : null,
    });
  }
  return out;
}

/**
 * Principals inferred from the grantees named in a privilege list.
 *
 * Db2 has no user catalog — accounts live in the operating system or a
 * directory service, and `SYSCAT.ROLES` holds only roles. An instance with no
 * user-defined roles therefore returns no principals at all, while the
 * privilege list still names real grantees such as PUBLIC and the instance
 * owner. Without this the panel shows privileges belonging to principals it
 * cannot list, and none of them can be selected to see what they hold.
 *
 * Used only as a fallback: a catalog that answers is always preferred, because
 * it also carries `canLogin` and role membership, which a grantee name cannot.
 */
export function principalsFromPrivileges(privileges: readonly DbPrivilege[]): DbPrincipal[] {
  const byName = new Map<string, DbPrincipal>();
  for (const priv of privileges) {
    const name = priv.grantee?.trim();
    if (!name) continue;
    const key = name.toUpperCase();
    if (byName.has(key)) continue;
    byName.set(key, {
      name,
      // A grantee name does not say whether it is a user or a role. `role` is
      // the safer read: it describes something that holds privileges, which is
      // all that is known here, and it keeps these out of the Users group where
      // a reader would expect an account that can log in.
      kind: 'role',
      canLogin: false,
      memberOf: [],
      members: [],
      superuser: null,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How two spellings of one principal are matched: quotes off, case folded.
 * `'app'@'%'` from information_schema and `app@%` from the principal list are
 * the same account; Oracle and Db2 fold names to upper case.
 */
export function principalKey(name: string): string {
  return stripQuotes(name).toLowerCase();
}

export function privilegesForPrincipal(
  privileges: readonly DbPrivilege[],
  principal: string
): DbPrivilege[] {
  const key = principalKey(principal);
  return privileges.filter((p) => principalKey(p.grantee) === key);
}

export function groupDbPrincipals(principals: readonly DbPrincipal[]): Array<{
  kind: 'role' | 'user';
  label: string;
  principals: DbPrincipal[];
}> {
  const roles = principals.filter((p) => p.kind === 'role' || p.kind === 'group');
  const users = principals.filter((p) => p.kind === 'user');
  return [
    { kind: 'role', label: 'Roles & groups', principals: roles },
    { kind: 'user', label: 'Users', principals: users },
  ];
}

/**
 * Make the two catalogs agree about role membership.
 *
 * Membership arrives two ways: `memberOf` / `members` on each principal, and
 * ROLE rows in the privilege list. Postgres, SQL Server and Oracle fill both;
 * the MySQL family and ClickHouse used to fill one, so the list said "member of
 * reader" while the detail pane said "Belongs to no roles". Each side is filled
 * from the other here, once, so every screen reads the same answer. Rows added
 * this way carry `source: 'derived'`.
 */
export function reconcileDbAccess(opts: {
  principals: readonly DbPrincipal[];
  privileges: readonly DbPrivilege[];
}): { principals: DbPrincipal[]; privileges: DbPrivilege[] } {
  const principals = opts.principals.map((p) => ({
    ...p,
    memberOf: [...p.memberOf],
    members: [...p.members],
  }));
  const privileges = [...opts.privileges];

  // Side 1: a ROLE row for every membership the principal list names.
  const edges = new Set<string>();
  const edgeKey = (member: string, role: string) => `${principalKey(member)}\u0000${principalKey(role)}`;
  for (const priv of privileges) {
    if (priv.objectType === 'ROLE') edges.add(edgeKey(priv.grantee, priv.objectName ?? priv.privilege));
  }
  const addRoleRow = (member: string, role: string) => {
    const k = edgeKey(member, role);
    if (edges.has(k)) return;
    edges.add(k);
    privileges.push({
      grantee: member,
      privilege: role,
      objectType: 'ROLE',
      objectSchema: null,
      objectName: role,
      grantable: false,
      grantor: null,
      state: null,
      source: 'derived',
    });
  };
  for (const p of principals) {
    for (const role of p.memberOf) addRoleRow(p.name, role);
    for (const member of p.members) addRoleRow(member, p.name);
  }

  // Side 2: memberOf / members for every ROLE row. Sets, not list scans: a
  // widely held role has thousands of members.
  const byName = new Map(principals.map((p) => [principalKey(p.name), p]));
  const memberOfKeys = new Map(principals.map((p) => [p, new Set(p.memberOf.map(principalKey))]));
  const membersKeys = new Map(principals.map((p) => [p, new Set(p.members.map(principalKey))]));
  for (const priv of privileges) {
    if (priv.objectType !== 'ROLE') continue;
    const role = priv.objectName ?? priv.privilege;
    const member = byName.get(principalKey(priv.grantee));
    if (member && !memberOfKeys.get(member)!.has(principalKey(role))) {
      memberOfKeys.get(member)!.add(principalKey(role));
      member.memberOf.push(role);
    }
    const rolePrincipal = byName.get(principalKey(role));
    if (rolePrincipal && !membersKeys.get(rolePrincipal)!.has(principalKey(priv.grantee))) {
      membersKeys.get(rolePrincipal)!.add(principalKey(priv.grantee));
      rolePrincipal.members.push(member?.name ?? stripQuotes(priv.grantee));
    }
  }
  return { principals, privileges };
}

/**
 * What SQL Server's fixed database roles confer with no permission row to say
 * so. Without these, `db_owner` — allowed everything in the database — listed
 * no privileges at all.
 */
const SQLSERVER_FIXED_ROLE_PRIVILEGES: Record<string, string[]> = {
  db_owner: ['CONTROL'],
  db_datareader: ['SELECT'],
  db_datawriter: ['INSERT', 'UPDATE', 'DELETE'],
};

/** The rows SQL Server's fixed roles imply, tagged `source: 'implied'`. Empty elsewhere. */
export function impliedFixedRolePrivileges(
  dialect: string,
  principals: readonly DbPrincipal[]
): DbPrivilege[] {
  if (family(dialect) !== 'sqlserver') return [];
  return principals.flatMap((p) =>
    (SQLSERVER_FIXED_ROLE_PRIVILEGES[p.name.toLowerCase()] ?? []).map(
      (privilege): DbPrivilege => ({
        grantee: p.name,
        privilege,
        objectType: 'DATABASE',
        objectSchema: null,
        objectName: null,
        grantable: false,
        grantor: null,
        state: 'grant',
        source: 'implied',
      })
    )
  );
}

/** Quote a principal for GRANT/REVOKE (MySQL `'user'@'host'`, Db2 `USER "x"`). */
export function formatDbGrantee(
  dialect: string,
  name: string,
  kind: DbPrincipalKind = 'user'
): string {
  const fam = family(dialect);
  const raw = stripQuotes(name);
  if (fam === 'mysql' || fam === 'mariadb') {
    // Quoted exactly as the account DDL in user-sql quotes it (backslashes
    // doubled before quotes, so `al\'ice` cannot close the literal early).
    // The catalog spells an account user@host.
    const at = raw.lastIndexOf('@');
    const user = at > 0 ? raw.slice(0, at) : raw;
    const host = at > 0 ? raw.slice(at + 1) : undefined;
    // A MariaDB role has no host: `'r'@'%'` names a user that does not exist.
    if (fam === 'mariadb' && kind === 'role') return mysqlRoleRef(user, host, dialect);
    if (host !== undefined) return `${mysqlQuote(user)}@${mysqlQuote(host)}`;
    // A bare name used to become `` `alice` ``, which is not an account —
    // CREATE USER and our catalog use 'alice'@'%', and GRANT TO `alice` either
    // fails or hits a role of that name. Default the host for users and roles.
    if (kind === 'user' || kind === 'role') return mysqlAccount(raw, undefined);
    return quoteSqlIdentifier(raw, dialect);
  }
  const ident = quoteSqlIdentifier(raw, dialect);
  if (fam === 'db2') {
    const prefix = kind === 'group' ? 'GROUP' : kind === 'role' ? 'ROLE' : 'USER';
    return `${prefix} ${ident}`;
  }
  return ident;
}

/**
 * The one shape every engine's GRANT and REVOKE share.
 *
 * Each family used to write this ternary out for itself — nine copies, varying
 * only in the ON clause. That is how Db2 came to omit DATABASE and emit
 * `ON TABLE` for a database authority: the case was handled in the generic
 * copy and missing from Db2's own. One emitter, and a family can only get its
 * ON clause wrong, not the statement around it.
 *
 * `on` is empty for privileges that take no object — a Db2 or SQL Server
 * system authority, or role membership.
 */
function emitGrant(opts: {
  action: 'grant' | 'revoke';
  privilege: string;
  on: string;
  grantee: string;
  /** Only ever set when granting; REVOKE has no such clause. */
  grantOption?: string;
}): { sql: string } {
  const on = opts.on ? ` ${opts.on}` : '';
  return {
    sql:
      opts.action === 'grant'
        ? `GRANT ${opts.privilege}${on} TO ${opts.grantee}${opts.grantOption ?? ''};`
        : `REVOKE ${opts.privilege}${on} FROM ${opts.grantee};`,
  };
}

export function buildGrantRevokeSql(args: DbAccessGrantArgs): { sql: string } | { error: string } {
  const support = dialectSupportsDbAccess(args.dialect);
  if (!support.grant) {
    return { error: support.hint || 'This dialect does not support GRANT/REVOKE.' };
  }
  const privilege = (args.privilege || '').trim();
  const grantee = (args.grantee || '').trim();
  if (!privilege) return { error: 'privilege is required.' };
  if (!grantee) return { error: 'grantee is required.' };

  const fam = family(args.dialect);
  const objectType = String(args.objectType || 'TABLE').toUpperCase();
  const ident = (name: string) => quoteSqlIdentifier(name, args.dialect);
  const granteeSql = formatDbGrantee(args.dialect, grantee, args.granteeKind ?? 'user');
  const objectSql = qualifyObject(args.dialect, objectType, args.objectSchema, args.objectName);
  const privSql = privilegeSql(fam, privilege);
  const action = args.action === 'grant' ? 'grant' : 'revoke';
  const grantOption = action === 'grant' && args.withGrantOption ? grantOptionClause(fam) : '';
  /** The schema or database being addressed, for the clauses that name one. */
  const namedObject = () => ident(args.objectName || args.objectSchema || '');

  // --- Role membership -----------------------------------------------------
  if (objectType === 'ROLE') {
    const roleName = (args.objectName || privilege).trim();
    if (!roleName) return { error: 'role name is required.' };
    // A MySQL role is an account, `'r'@'%'`; the catalog names it `r@%`, and a
    // backtick-quoted `r@%` is a role nobody created. Named like a grantee.
    const mysqlFamily = fam === 'mysql' || fam === 'mariadb';
    const roleSql = mysqlFamily ? formatDbGrantee(args.dialect, roleName, 'role') : ident(roleName);
    // SQL Server does not grant a role, it adds a member to one.
    if (fam === 'sqlserver') {
      const member = ident(stripQuotes(grantee));
      return {
        sql:
          action === 'grant'
            ? `ALTER ROLE ${roleSql} ADD MEMBER ${member};`
            : `ALTER ROLE ${roleSql} DROP MEMBER ${member};`,
      };
    }
    // Db2 names the object kind; every other engine grants the role directly,
    // Oracle included — it had its own branch emitting exactly this. A role is
    // passed on WITH ADMIN OPTION, not GRANT OPTION; the form's checkbox used
    // to be dropped here without a word.
    return emitGrant({
      action,
      privilege: fam === 'db2' ? `ROLE ${roleSql}` : roleSql,
      on: '',
      grantee: granteeSql,
      grantOption: action === 'grant' && args.withGrantOption ? ' WITH ADMIN OPTION' : undefined,
    });
  }

  if (!objectSql && objectType !== 'SYSTEM' && objectType !== 'DATABASE' && objectType !== 'GLOBAL') {
    return { error: 'object name is required.' };
  }

  if (objectType === 'GLOBAL' && fam !== 'mysql' && fam !== 'mariadb' && fam !== 'clickhouse') {
    return { error: 'This engine has no instance-wide (*.*) grant.' };
  }

  // --- Object privileges: each family supplies only its ON clause ----------
  if (fam === 'sqlserver') {
    // SQL Server scopes with a securable prefix rather than a keyword.
    const on =
      objectType === 'SYSTEM'
        ? ''
        : objectType === 'DATABASE'
          ? `ON DATABASE::${namedObject()}`
          : objectType === 'SCHEMA'
            ? `ON SCHEMA::${namedObject()}`
            : `ON OBJECT::${objectSql}`;
    return emitGrant({ action, privilege: privSql, on, grantee: granteeSql, grantOption });
  }

  if (fam === 'mysql' || fam === 'mariadb' || fam === 'clickhouse') {
    // These name the whole server `*.*` and a whole database `db`.* — a bare
    // `db` is a table reference, so a database-level grant landed on a table
    // of that name. ClickHouse takes no object keyword either.
    const target =
      objectType === 'GLOBAL'
        ? '*.*'
        : objectType === 'DATABASE' || objectType === 'SCHEMA'
          ? `${objectSql || namedObject()}.*`
          : objectSql || '*.*';
    return emitGrant({
      action,
      privilege: fam !== 'clickhouse' && privSql === 'ALL' ? 'ALL PRIVILEGES' : privSql,
      on: `ON ${target}`,
      grantee: granteeSql,
      grantOption,
    });
  }

  // Postgres, Oracle and Db2 share the keyword form; Db2 differs only in that
  // a database authority is granted ON DATABASE with no object named.
  const on =
    objectType === 'SYSTEM'
      ? ''
      : objectType === 'SCHEMA'
        ? `ON SCHEMA ${namedObject()}`
        : objectType === 'DATABASE'
          ? fam === 'db2'
            ? 'ON DATABASE'
            : `ON DATABASE ${namedObject()}`
          : `ON TABLE ${objectSql}`;
  return emitGrant({ action, privilege: privSql, on, grantee: granteeSql, grantOption });
}

function privilegeSql(fam: string, privilege: string): string {
  const p = privilege.trim().toUpperCase();
  if (p === 'ALL' && (fam === 'mysql' || fam === 'mariadb')) return 'ALL';
  if (p === 'ALL' && fam === 'sqlserver') {
    return 'SELECT, INSERT, UPDATE, DELETE, REFERENCES, ALTER';
  }
  return p;
}

function grantOptionClause(fam: string): string {
  if (fam === 'sqlserver') return ' WITH GRANT OPTION';
  return ' WITH GRANT OPTION';
}

function qualifyObject(
  dialect: string,
  objectType: string,
  schema: string | null | undefined,
  name: string | null | undefined
): string {
  const ident = (n: string) => quoteSqlIdentifier(n, dialect);
  const s = (schema ?? '').trim();
  const n = (name ?? '').trim();
  if (objectType === 'SCHEMA' || objectType === 'DATABASE') {
    return ident(n || s);
  }
  if (s && n) return `${ident(s)}.${ident(n)}`;
  if (n) return ident(n);
  if (s) return ident(s);
  return '';
}

function normalizeKind(raw: unknown): DbPrincipalKind {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('group') || s === 'g') return 'group';
  if (s.includes('role') || s === 'r') return 'role';
  return 'user';
}

function normalizeObjectType(raw: unknown): DbPrivilegeObjectType {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'GLOBAL') return 'GLOBAL';
  if (s.includes('COLUMN') && !s.includes('OBJECT_OR_COLUMN')) return 'COLUMN';
  if (s.includes('SCHEMA')) return 'SCHEMA';
  if (s.includes('DATABASE')) return 'DATABASE';
  if (s.includes('ROLE')) return 'ROLE';
  if (s.includes('SYSTEM') || s.includes('SERVER')) return 'SYSTEM';
  if (s.includes('TABLE') || s.includes('OBJECT') || s.includes('VIEW') || s.includes('OBJECT_OR_COLUMN')) {
    return 'TABLE';
  }
  if (!s) return 'TABLE';
  return 'OTHER';
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row) return row[key];
    const found = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
    if (found) return row[found];
  }
  return undefined;
}

function asString(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

function asBool(v: unknown): boolean | null {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  const s = String(v).trim().toLowerCase();
  if (['1', 't', 'true', 'y', 'yes', 'g'].includes(s)) return true;
  if (['0', 'f', 'false', 'n', 'no'].includes(s)) return false;
  return null;
}

function splitList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter(Boolean);
}

function stripQuotes(name: string): string {
  // information_schema prints a MySQL-family grantee as 'user'@'host', and a
  // MariaDB role as 'role'@'' — a role has no host, and its principal row is
  // the bare name. Without this the role read as `role'@` and matched nothing.
  const account = /^'((?:[^']|'')*)'@'((?:[^']|'')*)'$/.exec(name.trim());
  if (account) {
    const user = account[1]!.replace(/''/g, "'");
    const host = account[2]!.replace(/''/g, "'");
    return host ? `${user}@${host}` : user;
  }
  return name.replace(/^['"`\[]+/, '').replace(/['"`\]]+$/, '').replace(/'@'/g, '@');
}

function emptyToNull(s: string): string | null {
  return s ? s : null;
}

const PG_PRINCIPALS = `
SELECT r.rolname AS name,
       CASE WHEN r.rolcanlogin THEN 'user' ELSE 'role' END AS kind,
       r.rolcanlogin AS can_login,
       r.rolsuper AS superuser,
       COALESCE((
         SELECT string_agg(g.rolname, ',' ORDER BY g.rolname)
         FROM pg_auth_members am
         JOIN pg_roles g ON g.oid = am.roleid
         WHERE am.member = r.oid
       ), '') AS member_of,
       COALESCE((
         SELECT string_agg(m.rolname, ',' ORDER BY m.rolname)
         FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
         WHERE am.roleid = r.oid
       ), '') AS members
FROM pg_roles r
WHERE r.rolname NOT LIKE 'pg\\_%'
ORDER BY CASE WHEN r.rolcanlogin THEN 1 ELSE 0 END, r.rolname
`.trim();

const PG_PRINCIPALS_NO_SUPERUSER = `
SELECT r.rolname AS name,
       CASE WHEN r.rolcanlogin THEN 'user' ELSE 'role' END AS kind,
       r.rolcanlogin AS can_login,
       COALESCE((
         SELECT string_agg(g.rolname, ',' ORDER BY g.rolname)
         FROM pg_auth_members am
         JOIN pg_roles g ON g.oid = am.roleid
         WHERE am.member = r.oid
       ), '') AS member_of,
       COALESCE((
         SELECT string_agg(m.rolname, ',' ORDER BY m.rolname)
         FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
         WHERE am.roleid = r.oid
       ), '') AS members
FROM pg_roles r
WHERE r.rolname NOT LIKE 'pg\\_%'
ORDER BY CASE WHEN r.rolcanlogin THEN 1 ELSE 0 END, r.rolname
`.trim();

/**
 * Table grants, schema and database ACLs, and role memberships.
 *
 * Schema and database privileges come from the ACL columns. The earlier form
 * read `information_schema.usage_privileges WHERE object_type = 'SCHEMA'`, a
 * value that view never holds (it lists domains, collations, sequences and
 * foreign servers), so `GRANT ALL ON SCHEMA` and `GRANT ALL ON DATABASE` both
 * read as nothing. A NULL ACL is the owner-only default and yields no rows.
 */
const PG_PRIVILEGES = `
SELECT grantee,
       privilege_type AS privilege,
       'TABLE' AS object_type,
       table_schema AS object_schema,
       table_name AS object_name,
       CASE WHEN is_grantable = 'YES' THEN 1 ELSE 0 END AS grantable,
       grantor
FROM information_schema.role_table_grants
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
UNION ALL
SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
       a.privilege_type,
       'SCHEMA',
       n.nspname,
       NULL,
       CASE WHEN a.is_grantable THEN 1 ELSE 0 END,
       pg_get_userbyid(a.grantor)
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(n.nspacl) a
WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
UNION ALL
SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
       a.privilege_type,
       'DATABASE',
       NULL,
       d.datname,
       CASE WHEN a.is_grantable THEN 1 ELSE 0 END,
       pg_get_userbyid(a.grantor)
FROM pg_database d
CROSS JOIN LATERAL aclexplode(d.datacl) a
WHERE d.datname = current_database()
UNION ALL
SELECT m.rolname,
       g.rolname,
       'ROLE',
       NULL,
       g.rolname,
       CASE WHEN am.admin_option THEN 1 ELSE 0 END,
       NULL
FROM pg_auth_members am
JOIN pg_roles g ON g.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE g.rolname NOT LIKE 'pg\\_%'
`.trim();

const PG_PRIVILEGES_NO_ACL = `
SELECT grantee,
       privilege_type AS privilege,
       'TABLE' AS object_type,
       table_schema AS object_schema,
       table_name AS object_name,
       CASE WHEN is_grantable = 'YES' THEN 1 ELSE 0 END AS grantable,
       grantor
FROM information_schema.role_table_grants
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
UNION ALL
SELECT grantee,
       privilege_type,
       'SCHEMA',
       object_schema,
       object_name,
       CASE WHEN is_grantable = 'YES' THEN 1 ELSE 0 END,
       grantor
FROM information_schema.usage_privileges
WHERE object_type = 'SCHEMA'
UNION ALL
SELECT m.rolname,
       g.rolname,
       'ROLE',
       NULL,
       g.rolname,
       CASE WHEN am.admin_option THEN 1 ELSE 0 END,
       NULL
FROM pg_auth_members am
JOIN pg_roles g ON g.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE g.rolname NOT LIKE 'pg\\_%'
`.trim();

/**
 * A MySQL role is a row of mysql.user like any account. `CREATE ROLE` makes it
 * locked with no password, and that is how one is told apart — every row used
 * to be labelled `user`, which emptied "Roles & groups" on MySQL and TiDB.
 */
const MYSQL_PRINCIPALS = `
SELECT CONCAT(u.User, '@', u.Host) AS name,
       CASE WHEN u.account_locked = 'Y' AND COALESCE(u.authentication_string, '') = ''
            THEN 'role' ELSE 'user' END AS kind,
       CASE WHEN u.account_locked = 'Y' THEN 0 ELSE 1 END AS can_login,
       COALESCE((
         SELECT GROUP_CONCAT(DISTINCT CONCAT(e.FROM_USER, '@', e.FROM_HOST) ORDER BY e.FROM_USER)
         FROM mysql.role_edges e
         WHERE e.TO_USER = u.User AND e.TO_HOST = u.Host
       ), '') AS member_of,
       COALESCE((
         SELECT GROUP_CONCAT(DISTINCT CONCAT(e.TO_USER, '@', e.TO_HOST) ORDER BY e.TO_USER)
         FROM mysql.role_edges e
         WHERE e.FROM_USER = u.User AND e.FROM_HOST = u.Host
       ), '') AS members
FROM mysql.user u
WHERE u.User <> ''
ORDER BY u.User, u.Host
`.trim();

/**
 * MariaDB marks a role with `is_role` and gives it an empty host, and a role is
 * named without one everywhere (`GRANT r TO …`), so its row is the bare name.
 * `roles_mapping` holds memberships and also a role's creator, who is granted
 * it WITH ADMIN OPTION automatically.
 */
const MARIADB_PRINCIPALS = `
SELECT CASE WHEN u.is_role = 'Y' THEN u.User ELSE CONCAT(u.User, '@', u.Host) END AS name,
       CASE WHEN u.is_role = 'Y' THEN 'role' ELSE 'user' END AS kind,
       CASE WHEN u.is_role = 'Y' THEN 0 ELSE 1 END AS can_login,
       COALESCE((
         SELECT GROUP_CONCAT(DISTINCT rm.Role ORDER BY rm.Role)
         FROM mysql.roles_mapping rm
         WHERE rm.User = u.User AND rm.Host = u.Host
       ), '') AS member_of,
       CASE WHEN u.is_role = 'Y' THEN COALESCE((
         SELECT GROUP_CONCAT(DISTINCT CASE WHEN rm.Host = '' THEN rm.User
                                          ELSE CONCAT(rm.User, '@', rm.Host) END
                             ORDER BY rm.User)
         FROM mysql.roles_mapping rm
         WHERE rm.Role = u.User
       ), '') ELSE '' END AS members
FROM mysql.user u
WHERE u.User <> ''
ORDER BY u.User, u.Host
`.trim();

const MYSQL_PRINCIPALS_NO_ROLES = `
SELECT CONCAT(u.User, '@', u.Host) AS name, 'user' AS kind, 1 AS can_login,
       '' AS member_of, '' AS members
FROM mysql.user u
WHERE u.User <> ''
ORDER BY u.User, u.Host
`.trim();

const MYSQL_PRINCIPALS_FALLBACK = `
SELECT CURRENT_USER() AS name, 'user' AS kind, 1 AS can_login, '' AS member_of, '' AS members
`.trim();

/**
 * Table and schema grants, plus — the part that used to be missing — global
 * `ON *.*` grants and role memberships.
 *
 * `GRANT ALL PRIVILEGES ON *.*` lives only in USER_PRIVILEGES, so an account
 * holding every privilege on the server read as "No object privileges". USAGE
 * there means "no privileges" and is left out.
 */
function mysqlPrivilegesQuery(opts: {
  schemaFilter: boolean;
  global: boolean;
  roles: 'mysql' | 'mariadb' | null;
}): string {
  const inSchema = opts.schemaFilter ? '\nWHERE TABLE_SCHEMA = ?' : '';
  const parts = [
    `SELECT GRANTEE AS grantee,
       PRIVILEGE_TYPE AS privilege,
       'TABLE' AS object_type,
       TABLE_SCHEMA AS object_schema,
       TABLE_NAME AS object_name,
       CASE WHEN IS_GRANTABLE = 'YES' THEN 1 ELSE 0 END AS grantable,
       NULL AS grantor
FROM information_schema.TABLE_PRIVILEGES${inSchema}`,
    `SELECT GRANTEE,
       PRIVILEGE_TYPE,
       'SCHEMA',
       TABLE_SCHEMA,
       NULL,
       CASE WHEN IS_GRANTABLE = 'YES' THEN 1 ELSE 0 END,
       NULL
FROM information_schema.SCHEMA_PRIVILEGES${inSchema}`,
  ];
  if (opts.global) {
    parts.push(`SELECT GRANTEE,
       PRIVILEGE_TYPE,
       'GLOBAL',
       NULL,
       NULL,
       CASE WHEN IS_GRANTABLE = 'YES' THEN 1 ELSE 0 END,
       NULL
FROM information_schema.USER_PRIVILEGES
WHERE PRIVILEGE_TYPE <> 'USAGE'`);
  }
  if (opts.roles === 'mysql') {
    // Quoted the way information_schema quotes a grantee, so one normalizer
    // reads both. The role is named user@host, as its principal row is.
    parts.push(`SELECT CONCAT('''', e.TO_USER, '''@''', e.TO_HOST, ''''),
       CONCAT(e.FROM_USER, '@', e.FROM_HOST),
       'ROLE',
       NULL,
       CONCAT(e.FROM_USER, '@', e.FROM_HOST),
       CASE WHEN e.WITH_ADMIN_OPTION = 'Y' THEN 1 ELSE 0 END,
       NULL
FROM mysql.role_edges e`);
  } else if (opts.roles === 'mariadb') {
    parts.push(`SELECT CONCAT('''', rm.User, '''@''', rm.Host, ''''),
       rm.Role,
       'ROLE',
       NULL,
       rm.Role,
       CASE WHEN rm.Admin_option = 'Y' THEN 1 ELSE 0 END,
       NULL
FROM mysql.roles_mapping rm`);
  }
  return parts.join('\nUNION ALL\n');
}

/**
 * `superuser` is sysadmin membership of the login behind each database user.
 * IS_SRVROLEMEMBER answers NULL when the caller may not see it, which is kept
 * as "unknown" rather than read as "no".
 */
const MSSQL_PRINCIPALS = `
SELECT dp.name AS name,
       CASE
         WHEN dp.type IN ('R', 'A') THEN 'role'
         WHEN dp.type = 'G' THEN 'group'
         ELSE 'user'
       END AS kind,
       CASE WHEN dp.type IN ('S', 'U', 'E', 'X') THEN 1 ELSE 0 END AS can_login,
       CASE WHEN dp.sid IS NULL OR dp.type NOT IN ('S', 'U', 'G', 'E', 'X') THEN NULL
            ELSE IS_SRVROLEMEMBER('sysadmin', SUSER_SNAME(dp.sid)) END AS superuser,
       ISNULL(STUFF((
         SELECT ',' + r.name
         FROM sys.database_role_members rm
         JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
         WHERE rm.member_principal_id = dp.principal_id
         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, ''), '') AS member_of,
       ISNULL(STUFF((
         SELECT ',' + m.name
         FROM sys.database_role_members rm
         JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
         WHERE rm.role_principal_id = dp.principal_id
         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, ''), '') AS members
FROM sys.database_principals dp
WHERE dp.name IS NOT NULL
  AND dp.type IN ('S', 'U', 'G', 'R', 'A', 'E', 'X')
  AND dp.name NOT IN ('sys', 'INFORMATION_SCHEMA')
ORDER BY CASE WHEN dp.type IN ('R', 'A', 'G') THEN 0 ELSE 1 END, dp.name
`.trim();

const MSSQL_PRINCIPALS_NO_SERVER = `
SELECT dp.name AS name,
       CASE
         WHEN dp.type IN ('R', 'A') THEN 'role'
         WHEN dp.type = 'G' THEN 'group'
         ELSE 'user'
       END AS kind,
       CASE WHEN dp.type IN ('S', 'U', 'E', 'X') THEN 1 ELSE 0 END AS can_login,
       ISNULL(STUFF((
         SELECT ',' + r.name
         FROM sys.database_role_members rm
         JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
         WHERE rm.member_principal_id = dp.principal_id
         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, ''), '') AS member_of,
       ISNULL(STUFF((
         SELECT ',' + m.name
         FROM sys.database_role_members rm
         JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
         WHERE rm.role_principal_id = dp.principal_id
         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, ''), '') AS members
FROM sys.database_principals dp
WHERE dp.name IS NOT NULL
  AND dp.type IN ('S', 'U', 'G', 'R', 'A', 'E', 'X')
  AND dp.name NOT IN ('sys', 'INFORMATION_SCHEMA')
ORDER BY CASE WHEN dp.type IN ('R', 'A', 'G') THEN 0 ELSE 1 END, dp.name
`.trim();

const MSSQL_PRIVILEGES = `
SELECT dp.name AS grantee,
       p.permission_name AS privilege,
       p.class_desc AS object_type,
       OBJECT_SCHEMA_NAME(p.major_id) AS object_schema,
       OBJECT_NAME(p.major_id) AS object_name,
       CASE WHEN p.state = 'W' THEN 1 ELSE 0 END AS grantable,
       gp.name AS grantor,
       p.state_desc AS state
FROM sys.database_permissions p
JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
LEFT JOIN sys.database_principals gp ON gp.principal_id = p.grantor_principal_id
WHERE dp.name IS NOT NULL
UNION ALL
SELECT m.name,
       r.name,
       'ROLE',
       NULL,
       r.name,
       0,
       NULL,
       'GRANT'
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
`.trim();

const ORACLE_PRINCIPALS_DBA = `
SELECT u.USERNAME AS name, 'user' AS kind, 1 AS can_login,
       NVL((SELECT LISTAGG(rp.GRANTED_ROLE, ',') WITHIN GROUP (ORDER BY rp.GRANTED_ROLE)
            FROM DBA_ROLE_PRIVS rp WHERE rp.GRANTEE = u.USERNAME), '') AS member_of,
       '' AS members
FROM DBA_USERS u
UNION ALL
SELECT r.ROLE, 'role', 0,
       '',
       NVL((SELECT LISTAGG(rp.GRANTEE, ',') WITHIN GROUP (ORDER BY rp.GRANTEE)
            FROM DBA_ROLE_PRIVS rp WHERE rp.GRANTED_ROLE = r.ROLE), '')
FROM DBA_ROLES r
`.trim();

const ORACLE_PRINCIPALS_ALL = `
SELECT USERNAME AS name, 'user' AS kind, 1 AS can_login, '' AS member_of, '' AS members
FROM ALL_USERS
`.trim();

const ORACLE_PRIVILEGES_DBA = `
SELECT GRANTEE, PRIVILEGE, 'TABLE' AS object_type, OWNER AS object_schema, TABLE_NAME AS object_name,
       CASE WHEN GRANTABLE = 'YES' THEN 1 ELSE 0 END AS grantable, GRANTOR
FROM DBA_TAB_PRIVS
UNION ALL
SELECT GRANTEE, GRANTED_ROLE, 'ROLE', NULL, GRANTED_ROLE,
       CASE WHEN ADMIN_OPTION = 'YES' THEN 1 ELSE 0 END, NULL
FROM DBA_ROLE_PRIVS
UNION ALL
SELECT GRANTEE, PRIVILEGE, 'SYSTEM', NULL, NULL,
       CASE WHEN ADMIN_OPTION = 'YES' THEN 1 ELSE 0 END, NULL
FROM DBA_SYS_PRIVS
`.trim();

const ORACLE_PRIVILEGES_ALL = `
SELECT GRANTEE, PRIVILEGE, 'TABLE' AS object_type, OWNER AS object_schema, TABLE_NAME AS object_name,
       CASE WHEN GRANTABLE = 'YES' THEN 1 ELSE 0 END AS grantable, GRANTOR
FROM ALL_TAB_PRIVS
`.trim();

const DB2_PRINCIPALS = `
SELECT TRIM(U.GRANTEE) AS name,
       'user' AS kind,
       1 AS can_login,
       COALESCE((
         SELECT LISTAGG(TRIM(A.ROLENAME), ',') WITHIN GROUP (ORDER BY A.ROLENAME)
         FROM SYSCAT.ROLEAUTH A
         WHERE A.GRANTEETYPE = 'U'
           AND TRIM(A.GRANTEE) = TRIM(U.GRANTEE)
           AND A.ROLENAME NOT LIKE 'SYS%'
       ), '') AS member_of,
       '' AS members
FROM (
  SELECT DISTINCT GRANTEE
  FROM SYSCAT.DBAUTH
  WHERE GRANTEETYPE = 'U'
    AND CONNECTAUTH IN ('Y', 'G')
    AND TRIM(GRANTEE) NOT IN ('', 'PUBLIC')
    AND TRIM(GRANTEE) NOT LIKE 'SYS%'
  UNION
  SELECT DISTINCT GRANTEE
  FROM SYSCAT.ROLEAUTH
  WHERE GRANTEETYPE = 'U'
    AND TRIM(GRANTEE) NOT IN ('', 'PUBLIC')
    AND TRIM(GRANTEE) NOT LIKE 'SYS%'
  UNION
  SELECT DISTINCT GRANTEE
  FROM SYSCAT.TABAUTH
  WHERE GRANTEETYPE = 'U'
    AND TRIM(GRANTEE) NOT IN ('', 'PUBLIC')
    AND TRIM(GRANTEE) NOT LIKE 'SYS%'
) U
UNION ALL
SELECT TRIM(G.GRANTEE) AS name,
       'group' AS kind,
       0 AS can_login,
       COALESCE((
         SELECT LISTAGG(TRIM(A.ROLENAME), ',') WITHIN GROUP (ORDER BY A.ROLENAME)
         FROM SYSCAT.ROLEAUTH A
         WHERE A.GRANTEETYPE = 'G'
           AND TRIM(A.GRANTEE) = TRIM(G.GRANTEE)
           AND A.ROLENAME NOT LIKE 'SYS%'
       ), '') AS member_of,
       '' AS members
FROM (
  SELECT DISTINCT GRANTEE FROM SYSCAT.DBAUTH
  WHERE GRANTEETYPE = 'G' AND TRIM(GRANTEE) NOT IN ('', 'PUBLIC')
  UNION
  SELECT DISTINCT GRANTEE FROM SYSCAT.ROLEAUTH
  WHERE GRANTEETYPE = 'G' AND TRIM(GRANTEE) NOT IN ('', 'PUBLIC')
  UNION
  SELECT DISTINCT GRANTEE FROM SYSCAT.TABAUTH
  WHERE GRANTEETYPE = 'G' AND TRIM(GRANTEE) NOT IN ('', 'PUBLIC')
) G
UNION ALL
SELECT R.ROLENAME AS name,
       'role' AS kind,
       0 AS can_login,
       '' AS member_of,
       COALESCE((
         SELECT LISTAGG(TRIM(A.GRANTEE), ',') WITHIN GROUP (ORDER BY A.GRANTEE)
         FROM SYSCAT.ROLEAUTH A
         WHERE A.ROLENAME = R.ROLENAME
       ), '') AS members
FROM SYSCAT.ROLES R
WHERE R.ROLENAME NOT LIKE 'SYS%'
ORDER BY kind, name
`.trim();

const DB2_PRINCIPALS_ROLES = `
SELECT R.ROLENAME AS name,
       'role' AS kind,
       0 AS can_login,
       '' AS member_of,
       COALESCE((
         SELECT LISTAGG(TRIM(A.GRANTEE), ',') WITHIN GROUP (ORDER BY A.GRANTEE)
         FROM SYSCAT.ROLEAUTH A
         WHERE A.ROLENAME = R.ROLENAME
       ), '') AS members
FROM SYSCAT.ROLES R
WHERE R.ROLENAME NOT LIKE 'SYS%'
ORDER BY R.ROLENAME
`.trim();

const DB2_PRIVILEGES = `
SELECT TRIM(GRANTEE) AS grantee, 'CONNECT' AS privilege, 'DATABASE' AS object_type,
       NULL AS object_schema, NULL AS object_name,
       CASE WHEN CONNECTAUTH = 'G' THEN 1 ELSE 0 END AS grantable, TRIM(GRANTOR) AS grantor
FROM SYSCAT.DBAUTH
WHERE CONNECTAUTH IN ('Y', 'G') AND GRANTEETYPE IN ('U', 'G')
UNION ALL
SELECT TRIM(GRANTEE) AS grantee, 'SELECT' AS privilege, 'TABLE' AS object_type,
       TRIM(TABSCHEMA) AS object_schema, TRIM(TABNAME) AS object_name,
       CASE WHEN SELECTAUTH = 'G' THEN 1 ELSE 0 END AS grantable, TRIM(GRANTOR) AS grantor
FROM SYSCAT.TABAUTH WHERE SELECTAUTH IN ('Y', 'G')
UNION ALL
SELECT TRIM(GRANTEE), 'INSERT', 'TABLE', TRIM(TABSCHEMA), TRIM(TABNAME),
       CASE WHEN INSERTAUTH = 'G' THEN 1 ELSE 0 END, TRIM(GRANTOR)
FROM SYSCAT.TABAUTH WHERE INSERTAUTH IN ('Y', 'G')
UNION ALL
SELECT TRIM(GRANTEE), 'UPDATE', 'TABLE', TRIM(TABSCHEMA), TRIM(TABNAME),
       CASE WHEN UPDATEAUTH = 'G' THEN 1 ELSE 0 END, TRIM(GRANTOR)
FROM SYSCAT.TABAUTH WHERE UPDATEAUTH IN ('Y', 'G')
UNION ALL
SELECT TRIM(GRANTEE), 'DELETE', 'TABLE', TRIM(TABSCHEMA), TRIM(TABNAME),
       CASE WHEN DELETEAUTH = 'G' THEN 1 ELSE 0 END, TRIM(GRANTOR)
FROM SYSCAT.TABAUTH WHERE DELETEAUTH IN ('Y', 'G')
UNION ALL
SELECT TRIM(GRANTEE), TRIM(ROLENAME), 'ROLE', NULL, TRIM(ROLENAME), 0, NULL
FROM SYSCAT.ROLEAUTH
WHERE ROLENAME NOT LIKE 'SYS%'
`.trim();

/**
 * Memberships live in system.role_grants, which the first version never read,
 * so no ClickHouse account showed a role. ClickHouse has no correlated
 * subqueries, hence the joins on pre-aggregated lists.
 */
const CLICKHOUSE_PRINCIPALS = `
SELECT p.name AS name, p.kind AS kind, p.can_login AS can_login,
       m.member_of AS member_of, r.members AS members
FROM (
  SELECT name, 'user' AS kind, 1 AS can_login FROM system.users
  UNION ALL
  SELECT name, 'role', 0 FROM system.roles
) p
LEFT JOIN (
  SELECT ifNull(user_name, role_name) AS who,
         arrayStringConcat(groupArray(granted_role_name), ',') AS member_of
  FROM system.role_grants
  GROUP BY who
) m ON m.who = p.name
LEFT JOIN (
  SELECT granted_role_name AS role,
         arrayStringConcat(groupArray(ifNull(user_name, role_name)), ',') AS members
  FROM system.role_grants
  GROUP BY role
) r ON r.role = p.name
`.trim();

const CLICKHOUSE_PRINCIPALS_NO_ROLE_GRANTS = `
SELECT name, 'user' AS kind, 1 AS can_login, '' AS member_of, '' AS members FROM system.users
UNION ALL
SELECT name, 'role', 0, '', '' FROM system.roles
`.trim();

/**
 * A grant with no database is `ON *.*`. The NULL used to fall through the
 * `database != ''` test to 'SYSTEM', so every instance-wide grant read as a
 * system authority. Role memberships come from system.role_grants.
 */
const CLICKHOUSE_PRIVILEGES = `
SELECT ifNull(user_name, role_name) AS grantee,
       toString(access_type) AS privilege,
       multiIf(ifNull(table, '') != '', 'TABLE', ifNull(database, '') != '', 'SCHEMA', 'GLOBAL') AS object_type,
       nullIf(ifNull(database, ''), '') AS object_schema,
       nullIf(ifNull(table, ''), '') AS object_name,
       grant_option AS grantable,
       NULL AS grantor
FROM system.grants
UNION ALL
SELECT ifNull(user_name, role_name),
       granted_role_name,
       'ROLE',
       NULL,
       granted_role_name,
       with_admin_option,
       NULL
FROM system.role_grants
`.trim();

const GENERIC_PRINCIPALS = `
SELECT GRANTEE AS name, 'user' AS kind, 1 AS can_login, '' AS member_of, '' AS members
FROM information_schema.TABLE_PRIVILEGES
GROUP BY GRANTEE
`.trim();

const GENERIC_PRIVILEGES = `
SELECT GRANTEE AS grantee,
       PRIVILEGE_TYPE AS privilege,
       'TABLE' AS object_type,
       TABLE_SCHEMA AS object_schema,
       TABLE_NAME AS object_name,
       CASE WHEN IS_GRANTABLE = 'YES' THEN 1 ELSE 0 END AS grantable,
       NULL AS grantor
FROM information_schema.TABLE_PRIVILEGES
`.trim();
