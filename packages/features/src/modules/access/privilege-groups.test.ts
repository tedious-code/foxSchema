/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { buildGrantRevokeSql, type DbPrincipal, type DbPrivilege } from './db-access.js';
import {
  allPrivilegeTargets,
  describeAllowAll,
  findAllowAll,
  findAllowAllByName,
  groupPrivileges,
  isAllPrivilegeSet,
  privilegeTargetLabel,
} from './privilege-groups.js';

const priv = (
  grantee: string,
  privilege: string,
  objectType: DbPrivilege['objectType'],
  objectSchema: string | null = null,
  objectName: string | null = null,
  state: DbPrivilege['state'] = null
): DbPrivilege => ({
  grantee,
  privilege,
  objectType,
  objectSchema,
  objectName,
  grantable: false,
  grantor: null,
  state,
});

const principal = (name: string, extra: Partial<DbPrincipal> = {}): DbPrincipal => ({
  name,
  kind: 'user',
  canLogin: true,
  memberOf: [],
  members: [],
  ...extra,
});

/** What `GRANT ALL PRIVILEGES ON *.*` left in TiDB's USER_PRIVILEGES, verbatim. */
const TIDB_GLOBAL_ALL =
  'ALTER,ALTER ROUTINE,CONFIG,CREATE,CREATE ROLE,CREATE ROUTINE,CREATE TABLESPACE,CREATE TEMPORARY TABLES,CREATE USER,CREATE VIEW,DELETE,DROP,DROP ROLE,EVENT,EXECUTE,FILE,INDEX,INSERT,LOCK TABLES,PROCESS,REFERENCES,RELOAD,REPLICATION CLIENT,REPLICATION SLAVE,SELECT,SHOW DATABASES,SHOW VIEW,SHUTDOWN,SUPER,TRIGGER,UPDATE'.split(
    ','
  );

describe('isAllPrivilegeSet', () => {
  it("recognises the MySQL family's expanded ALL PRIVILEGES ON *.*", () => {
    expect(isAllPrivilegeSet('tidb', 'GLOBAL', TIDB_GLOBAL_ALL)).toBe(true);
    expect(isAllPrivilegeSet('mysql', 'GLOBAL', TIDB_GLOBAL_ALL)).toBe(true);
  });

  it('does not call a partial set ALL', () => {
    expect(isAllPrivilegeSet('mysql', 'GLOBAL', ['SELECT', 'INSERT'])).toBe(false);
    expect(isAllPrivilegeSet('mysql', 'GLOBAL', TIDB_GLOBAL_ALL.filter((p) => p !== 'SHUTDOWN'))).toBe(
      false
    );
  });

  it("recognises Postgres's seven table privileges, and a superset", () => {
    const seven = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    expect(isAllPrivilegeSet('postgres', 'TABLE', seven)).toBe(true);
    expect(isAllPrivilegeSet('postgres', 'TABLE', [...seven, 'MAINTAIN'])).toBe(true);
    expect(isAllPrivilegeSet('postgres', 'TABLE', seven.slice(1))).toBe(false);
  });

  it('takes ALL, ALL PRIVILEGES and CONTROL at their word', () => {
    expect(isAllPrivilegeSet('clickhouse', 'GLOBAL', ['ALL'])).toBe(true);
    expect(isAllPrivilegeSet('sqlserver', 'DATABASE', ['CONTROL'])).toBe(true);
    expect(isAllPrivilegeSet('oracle', 'TABLE', ['all privileges'])).toBe(true);
  });

  it('knows no set for an engine it has none for', () => {
    expect(isAllPrivilegeSet('db2', 'TABLE', ['SELECT', 'INSERT'])).toBe(false);
    expect(isAllPrivilegeSet('mysql', 'GLOBAL', [])).toBe(false);
  });
});

describe('groupPrivileges', () => {
  it('groups by object, keeps DENY apart, and leaves role memberships out', () => {
    const groups = groupPrivileges(
      [
        priv('a', 'SELECT', 'TABLE', 'dbo', 't'),
        priv('a', 'INSERT', 'TABLE', 'dbo', 't'),
        priv('a', 'DELETE', 'TABLE', 'dbo', 't', 'deny'),
        priv('a', 'reader', 'ROLE', null, 'reader'),
        priv('a', 'SELECT', 'TABLE', 'dbo', 'u'),
      ],
      'sqlserver'
    );
    expect(groups.map((g) => [g.objectName, g.state, g.privileges.length])).toEqual([
      ['t', null, 2],
      ['t', 'deny', 1],
      ['u', null, 1],
    ]);
  });

  it('marks a complete set, and never a DENY', () => {
    const groups = groupPrivileges(
      [
        ...TIDB_GLOBAL_ALL.map((p) => priv('app@%', p, 'GLOBAL')),
        priv('x', 'CONTROL', 'DATABASE', null, null, 'deny'),
      ],
      'tidb'
    );
    expect(groups.map((g) => g.all)).toEqual([true, false]);
  });
});

describe('privilegeTargetLabel', () => {
  it('says *.* in words', () => {
    expect(privilegeTargetLabel({ objectType: 'GLOBAL', objectSchema: null, objectName: null })).toBe(
      'every database (*.*)'
    );
    expect(privilegeTargetLabel({ objectType: 'SCHEMA', objectSchema: 'demo_a', objectName: null })).toBe(
      'demo_a.* (schema)'
    );
    expect(privilegeTargetLabel({ objectType: 'TABLE', objectSchema: 's', objectName: 't' })).toBe('s.t');
  });
});

describe('findAllowAll', () => {
  const globalAll = (who: string) => TIDB_GLOBAL_ALL.map((p) => priv(who, p, 'GLOBAL'));

  it('finds a superuser', () => {
    const allow = findAllowAll({
      principal: 'root',
      principals: [principal('root', { superuser: true })],
      privileges: [],
      dialect: 'postgres',
    });
    expect(allow).toEqual({ kind: 'superuser', holder: 'root', via: [] });
    expect(describeAllowAll(allow!)).toMatch(/bypasses every permission check/);
  });

  it('finds every privilege ON *.*', () => {
    const allow = findAllowAll({
      principal: 'app@%',
      principals: [principal('app@%')],
      privileges: globalAll('app@%'),
      dialect: 'mysql',
    });
    expect(allow?.kind).toBe('all-on-server');
  });

  it('follows role membership, nearest holder first', () => {
    const allow = findAllowAll({
      principal: 'app@%',
      principals: [
        principal('app@%', { memberOf: ['ops@%'] }),
        principal('ops@%', { kind: 'role', memberOf: ['admin@%'] }),
        principal('admin@%', { kind: 'role' }),
      ],
      privileges: globalAll('admin@%'),
      dialect: 'mysql',
    });
    expect(allow).toEqual({ kind: 'all-on-server', holder: 'admin@%', via: ['ops@%', 'admin@%'] });
    expect(describeAllowAll(allow!)).toMatch(/Inherited through ops@% → admin@%/);
  });

  it("finds SQL Server's db_owner through its implied CONTROL", () => {
    const allow = findAllowAll({
      principal: 'app',
      principals: [principal('app', { memberOf: ['db_owner'] }), principal('db_owner', { kind: 'role' })],
      privileges: [{ ...priv('db_owner', 'CONTROL', 'DATABASE'), state: 'grant', source: 'implied' }],
      dialect: 'sqlserver',
    });
    expect(allow).toEqual({ kind: 'all-on-database', holder: 'db_owner', via: ['db_owner'] });
  });

  it("does not call Postgres ALL ON DATABASE allow-all: it reads no table", () => {
    const allow = findAllowAll({
      principal: 'app',
      principals: [principal('app')],
      privileges: ['CONNECT', 'CREATE', 'TEMPORARY'].map((p) => priv('app', p, 'DATABASE', null, 'foxdb')),
      dialect: 'postgres',
    });
    expect(allow).toBeNull();
  });

  it('is null for an ordinary account', () => {
    expect(
      findAllowAll({
        principal: 'app@%',
        principals: [principal('app@%')],
        privileges: [priv('app@%', 'SELECT', 'GLOBAL')],
        dialect: 'mysql',
      })
    ).toBeNull();
  });
});

describe('allPrivilegeTargets', () => {
  const grantAll = (dialect: string, id: string, grantee: string) => {
    const t = allPrivilegeTargets(dialect, { database: 'app', schema: 'sales' }).find((x) => x.id === id);
    if (!t) throw new Error(`${dialect} offers no ${id}`);
    const built = buildGrantRevokeSql({
      dialect,
      action: 'grant',
      privilege: t.privilege,
      objectType: t.objectType,
      objectSchema: null,
      objectName: t.objectName,
      grantee,
    });
    if ('error' in built) throw new Error(built.error);
    return built.sql;
  };

  it('spells "everything" the way each engine does', () => {
    expect(grantAll('mysql', 'server', 'app@%')).toBe("GRANT ALL PRIVILEGES ON *.* TO 'app'@'%';");
    expect(grantAll('tidb', 'database', 'app@%')).toBe("GRANT ALL PRIVILEGES ON `sales`.* TO 'app'@'%';");
    expect(grantAll('clickhouse', 'server', 'app')).toBe('GRANT ALL ON *.* TO `app`;');
    expect(grantAll('clickhouse', 'database', 'app')).toBe('GRANT ALL ON `sales`.* TO `app`;');
    expect(grantAll('postgres', 'database', 'app')).toBe('GRANT ALL ON DATABASE "app" TO "app";');
    expect(grantAll('postgres', 'schema', 'app')).toBe('GRANT ALL ON SCHEMA "sales" TO "app";');
    expect(grantAll('sqlserver', 'database', 'app')).toBe('GRANT CONTROL ON DATABASE::[app] TO [app];');
    expect(grantAll('oracle', 'system', 'APP')).toBe('GRANT ALL PRIVILEGES TO "APP";');
    expect(grantAll('db2', 'database', 'APP')).toBe('GRANT DBADM ON DATABASE TO USER "APP";');
  });

  it('offers Postgres no server-wide grant, and says why', () => {
    const targets = allPrivilegeTargets('postgres', { database: 'app', schema: 'sales' });
    expect(targets.map((t) => t.id)).toEqual(['database', 'schema']);
    expect(targets[0]!.note).toMatch(/reads no table/);
    expect(targets[0]!.note).toMatch(/SUPERUSER/);
  });

  it('offers nothing on engines without GRANT', () => {
    expect(allPrivilegeTargets('sqlite', { database: 'x' })).toEqual([]);
  });
});

describe('findAllowAllByName', () => {
  it('answers for every principal exactly as findAllowAll does one at a time', () => {
    const principals = [
      principal('app@%', { memberOf: ['ops@%'] }),
      principal('ops@%', { kind: 'role', memberOf: ['admin@%'] }),
      principal('admin@%', { kind: 'role' }),
      principal('root@%', { superuser: true }),
      principal('plain@%'),
    ];
    const privileges = TIDB_GLOBAL_ALL.map((p) => priv("'admin'@'%'", p, 'GLOBAL'));
    const all = findAllowAllByName({ principals, privileges, dialect: 'mysql' });
    for (const p of principals) {
      expect(all.get(p.name) ?? null, p.name).toEqual(
        findAllowAll({ principal: p.name, principals, privileges, dialect: 'mysql' })
      );
    }
    expect([...all.keys()]).toEqual(['app@%', 'ops@%', 'admin@%', 'root@%']);
  });
});
