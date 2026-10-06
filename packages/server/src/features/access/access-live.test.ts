/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Access grants, read back from the real database servers.
 *
 * The unit tests prove the catalog SQL is the text intended. Only a server can
 * say the catalog it names exists, that it lists what was granted, and that a
 * REVOKE built for it is one it accepts. Per engine this creates a role, a
 * table and (where the engine has them) a function and a procedure, grants on
 * each plus one database- or schema-wide privilege, reads them back exactly as
 * the Access panel does (`probeDbAccess`, the same ladder and normalisation),
 * splits them the way the Grants view does, revokes the routine grant with the
 * SQL the app writes, and reads again.
 *
 * Gated behind FOX_IT_DB=1, like generated-ddl-live.test.ts:
 *
 *   docker compose up -d
 *   FOX_IT_DB=1 npx vitest run packages/server/src/features/access/access-live.test.ts
 *
 * An engine whose container does not answer its own probe is skipped by name,
 * with the reason; it never reports as a pass.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ConnectionFactory, getAdapter } from '@foxschema/db';
import {
  buildAccessSql,
  buildGrantRevokeSql,
  describeHeldPrivilege,
  privilegesForPrincipal,
  principalKey,
  splitHeldPrivileges,
  type ConnectionOptions,
  type DbPrivilege,
  type DbPrivilegeObjectType,
  type GridObjectKind,
} from '@foxschema/sql';
import { probeDbAccess } from './db-access.service.js';

const RUN = process.env.FOX_IT_DB === '1';

/** Unique per run, so a rerun never collides with what an earlier one left. */
const TAG = Date.now().toString(36).slice(-5);

interface Routine {
  kind: Extract<GridObjectKind, 'function' | 'procedure'>;
  name: string;
  /** The object type the engine's catalog reports the grant under. */
  reportedAs: DbPrivilegeObjectType;
}

interface Engine {
  dialect: string;
  options: ConnectionOptions;
  /** Liveness query; Db2 and Oracle reject a bare `SELECT 1`. */
  probe?: string;
  /** The schema the Access panel would be opened on. */
  schema: string;
  /** The role, as the catalog lists it. */
  principal: string;
  table: string;
  /** The engine's routines, or why it has none to grant on. */
  routines: Routine[] | { none: string };
  /** The database- or schema-wide grant, as `describeHeldPrivilege` puts it. */
  wide: { objectType: DbPrivilegeObjectType; privilege: string; describedAs: RegExp };
  /** Admin statements that make the role, objects and grants. */
  setup: string[];
  /** Dropped in afterAll, each on its own so one failure does not stop the rest. */
  teardown: string[];
  /** Oracle: also revoke the table grant, the `ON TABLE` fix. */
  revokeTable?: boolean;
  /** Why the grid draws no cell for a table grant here, so it is listed under it instead. */
  noGridCells?: string;
}

const pg = (opts: { options: ConnectionOptions; database: string; procedures?: boolean }): Omit<Engine, 'dialect'> => {
  const r = `fx_r_${TAG}`;
  const t = `fx_t_${TAG}`;
  const f = `fx_f_${TAG}`;
  const p = `fx_p_${TAG}`;
  return {
    options: opts.options,
    schema: 'public',
    principal: r,
    table: t,
    routines: [
      // Joined to information_schema.routines for the kind.
      { kind: 'function', name: f, reportedAs: 'FUNCTION' },
      { kind: 'procedure', name: p, reportedAs: 'PROCEDURE' },
    ],
    wide: { objectType: 'DATABASE', privilege: 'CONNECT', describedAs: new RegExp(`^CONNECT on database ${opts.database}$`) },
    setup: [
      `CREATE ROLE ${r}`,
      `CREATE TABLE public.${t} (id INT)`,
      `CREATE FUNCTION public.${f}() RETURNS INT LANGUAGE SQL AS 'SELECT 1'`,
      `CREATE PROCEDURE public.${p}() LANGUAGE SQL AS 'SELECT 1'`,
      `GRANT SELECT ON TABLE public.${t} TO ${r}`,
      `GRANT EXECUTE ON FUNCTION public.${f}() TO ${r}`,
      `GRANT EXECUTE ON PROCEDURE public.${p}() TO ${r}`,
      `GRANT CONNECT ON DATABASE ${opts.database} TO ${r}`,
    ],
    teardown: [
      `DROP PROCEDURE IF EXISTS public.${p}()`,
      `DROP FUNCTION IF EXISTS public.${f}()`,
      `DROP TABLE IF EXISTS public.${t}`,
      `REVOKE CONNECT ON DATABASE ${opts.database} FROM ${r}`,
      `DROP ROLE IF EXISTS ${r}`,
    ],
  };
};

const mysqlLike = (opts: {
  options: ConnectionOptions;
  db: string;
  /** How the catalog spells the role: MySQL `r@%`, MariaDB the bare name. */
  principal: (r: string) => string;
  routines: boolean;
}): Omit<Engine, 'dialect'> => {
  const r = `fx_r_${TAG}`;
  const t = `fx_t_${TAG}`;
  const f = `fx_f_${TAG}`;
  const p = `fx_p_${TAG}`;
  return {
    options: opts.options,
    schema: opts.db,
    principal: opts.principal(r),
    table: t,
    routines: opts.routines
      ? [
          { kind: 'function', name: f, reportedAs: 'FUNCTION' },
          { kind: 'procedure', name: p, reportedAs: 'PROCEDURE' },
        ]
      : { none: 'TiDB has no stored procedures or functions.' },
    wide: { objectType: 'SCHEMA', privilege: 'CREATE', describedAs: new RegExp(`^CREATE on schema ${opts.db}$`) },
    setup: [
      `CREATE ROLE '${r}'`,
      `CREATE TABLE ${opts.db}.${t} (id INT)`,
      ...(opts.routines
        ? [
            `CREATE FUNCTION ${opts.db}.${f}() RETURNS INT DETERMINISTIC RETURN 1`,
            `CREATE PROCEDURE ${opts.db}.${p}() SELECT 1`,
            `GRANT EXECUTE ON FUNCTION ${opts.db}.${f} TO '${r}'`,
            `GRANT EXECUTE ON PROCEDURE ${opts.db}.${p} TO '${r}'`,
          ]
        : []),
      `GRANT SELECT ON ${opts.db}.${t} TO '${r}'`,
      `GRANT CREATE ON ${opts.db}.* TO '${r}'`,
    ],
    teardown: [
      ...(opts.routines ? [`DROP PROCEDURE IF EXISTS ${opts.db}.${p}`, `DROP FUNCTION IF EXISTS ${opts.db}.${f}`] : []),
      `DROP TABLE IF EXISTS ${opts.db}.${t}`,
      `DROP ROLE IF EXISTS '${r}'`,
    ],
  };
};

const UP = TAG.toUpperCase();

const ENGINES: Engine[] = [
  {
    dialect: 'postgres',
    ...pg({
      options: { host: 'localhost', port: 5432, database: 'foxdb', username: 'foxuser', password: 'foxpass', schema: 'public' },
      database: 'foxdb',
    }),
  },
  {
    dialect: 'yugabytedb',
    ...pg({
      options: { host: 'localhost', port: 5433, database: 'yugabyte', username: 'yugabyte', schema: 'public' },
      database: 'yugabyte',
    }),
  },
  {
    dialect: 'cockroachdb',
    ...pg({
      options: { host: 'localhost', port: 26257, database: 'defaultdb', username: 'root', schema: 'public' },
      database: 'defaultdb',
    }),
  },
  {
    // A Postgres container standing in for Redshift (docker-compose.yml), so
    // only what both share is asserted: a table grant and a schema grant.
    // Routines are left out: Redshift's differ, and a pass on Postgres would
    // say nothing about them.
    dialect: 'redshift',
    options: {
      host: 'localhost',
      port: 5439,
      database: 'foxdb',
      username: 'foxuser',
      password: 'foxpass',
      schema: 'public',
      ssl: { enabled: true, rejectUnauthorized: false },
    },
    schema: 'public',
    principal: `fx_r_${TAG}`,
    table: `fx_t_${TAG}`,
    routines: { none: 'the local stand-in is Postgres, whose routines are not Redshift’s.' },
    wide: { objectType: 'SCHEMA', privilege: 'USAGE', describedAs: /^USAGE on schema public$/ },
    setup: [
      `CREATE ROLE fx_r_${TAG}`,
      `CREATE TABLE public.fx_t_${TAG} (id INT)`,
      `GRANT SELECT ON TABLE public.fx_t_${TAG} TO fx_r_${TAG}`,
      `GRANT USAGE ON SCHEMA public TO fx_r_${TAG}`,
    ],
    teardown: [
      `DROP TABLE IF EXISTS public.fx_t_${TAG}`,
      `REVOKE USAGE ON SCHEMA public FROM fx_r_${TAG}`,
      `DROP ROLE IF EXISTS fx_r_${TAG}`,
    ],
  },
  {
    dialect: 'mysql',
    ...mysqlLike({
      options: { host: 'localhost', port: 3306, database: 'foxdb', username: 'root', password: 'foxrootpass' },
      db: 'foxdb',
      principal: (r) => `${r}@%`,
      routines: true,
    }),
  },
  {
    dialect: 'mariadb',
    ...mysqlLike({
      options: { host: 'localhost', port: 3307, database: 'foxdb', username: 'root', password: 'foxrootpass' },
      db: 'foxdb',
      principal: (r) => r,
      routines: true,
    }),
  },
  {
    dialect: 'tidb',
    ...mysqlLike({
      options: { host: 'localhost', port: 4000, database: 'test', username: 'root', password: '' },
      db: 'test',
      principal: (r) => `${r}@%`,
      routines: false,
    }),
  },
  {
    dialect: 'sqlserver',
    options: { host: 'localhost', port: 1433, database: 'master', username: 'sa', password: 'FoxPass123!', ssl: { enabled: false } },
    schema: 'dbo',
    principal: `fx_r_${TAG}`,
    table: `fx_t_${TAG}`,
    // database_permissions reports every schema-scoped object as
    // OBJECT_OR_COLUMN; the grid matches a routine by name, so it still ticks.
    routines: [
      { kind: 'function', name: `fx_f_${TAG}`, reportedAs: 'TABLE' },
      { kind: 'procedure', name: `fx_p_${TAG}`, reportedAs: 'TABLE' },
    ],
    wide: { objectType: 'DATABASE', privilege: 'CREATE TABLE', describedAs: /^CREATE TABLE on the database$/ },
    setup: [
      `CREATE ROLE fx_r_${TAG}`,
      `CREATE TABLE dbo.fx_t_${TAG} (id INT)`,
      `CREATE FUNCTION dbo.fx_f_${TAG}() RETURNS INT AS BEGIN RETURN 1 END`,
      `CREATE PROCEDURE dbo.fx_p_${TAG} AS SELECT 1`,
      `GRANT SELECT ON dbo.fx_t_${TAG} TO fx_r_${TAG}`,
      `GRANT EXECUTE ON dbo.fx_f_${TAG} TO fx_r_${TAG}`,
      `GRANT EXECUTE ON dbo.fx_p_${TAG} TO fx_r_${TAG}`,
      `GRANT CREATE TABLE TO fx_r_${TAG}`,
    ],
    teardown: [
      `DROP PROCEDURE IF EXISTS dbo.fx_p_${TAG}`,
      `DROP FUNCTION IF EXISTS dbo.fx_f_${TAG}`,
      `DROP TABLE IF EXISTS dbo.fx_t_${TAG}`,
      `DROP ROLE IF EXISTS fx_r_${TAG}`,
    ],
  },
  {
    dialect: 'oracle',
    options: { host: 'localhost', port: 1521, database: 'FOXDB', username: 'system', password: 'FoxPass123', schema: 'FOXUSER' },
    probe: 'SELECT 1 FROM DUAL',
    schema: 'FOXUSER',
    principal: `FX_R_${UP}`,
    table: `FX_T_${UP}`,
    // DBA_TAB_PRIVS has no routine kind in the columns the ladder reads.
    routines: [
      { kind: 'function', name: `FX_F_${UP}`, reportedAs: 'TABLE' },
      { kind: 'procedure', name: `FX_P_${UP}`, reportedAs: 'TABLE' },
    ],
    wide: { objectType: 'SYSTEM', privilege: 'CREATE SESSION', describedAs: /^CREATE SESSION \(server-wide\)$/ },
    setup: [
      `CREATE ROLE FX_R_${UP}`,
      `CREATE TABLE FOXUSER.FX_T_${UP} (ID NUMBER)`,
      `CREATE FUNCTION FOXUSER.FX_F_${UP} RETURN NUMBER AS BEGIN RETURN 1; END;`,
      `CREATE PROCEDURE FOXUSER.FX_P_${UP} AS BEGIN NULL; END;`,
      `GRANT SELECT ON FOXUSER.FX_T_${UP} TO FX_R_${UP}`,
      `GRANT EXECUTE ON FOXUSER.FX_F_${UP} TO FX_R_${UP}`,
      `GRANT EXECUTE ON FOXUSER.FX_P_${UP} TO FX_R_${UP}`,
      `GRANT CREATE SESSION TO FX_R_${UP}`,
    ],
    teardown: [
      `DROP PROCEDURE FOXUSER.FX_P_${UP}`,
      `DROP FUNCTION FOXUSER.FX_F_${UP}`,
      `DROP TABLE FOXUSER.FX_T_${UP} PURGE`,
      `DROP ROLE FX_R_${UP}`,
    ],
    revokeTable: true,
  },
  {
    dialect: 'db2',
    options: { host: 'localhost', port: 50000, database: 'foxdb', username: 'db2inst1', password: 'foxpass', schema: 'DB2INST1' },
    probe: 'SELECT 1 FROM SYSIBM.SYSDUMMY1',
    schema: 'DB2INST1',
    principal: `FX_R_${UP}`,
    table: `FX_T_${UP}`,
    routines: [
      { kind: 'function', name: `FX_F_${UP}`, reportedAs: 'FUNCTION' },
      { kind: 'procedure', name: `FX_P_${UP}`, reportedAs: 'PROCEDURE' },
    ],
    wide: { objectType: 'DATABASE', privilege: 'CONNECT', describedAs: /^CONNECT on the database$/ },
    setup: [
      `CREATE ROLE FX_R_${UP}`,
      `CREATE TABLE DB2INST1.FX_T_${UP} (ID INT)`,
      `CREATE FUNCTION DB2INST1.FX_F_${UP}() RETURNS INT LANGUAGE SQL RETURN 1`,
      `CREATE PROCEDURE DB2INST1.FX_P_${UP}() LANGUAGE SQL BEGIN DECLARE V INT; SET V = 1; END`,
      `GRANT SELECT ON TABLE DB2INST1.FX_T_${UP} TO ROLE FX_R_${UP}`,
      `GRANT EXECUTE ON FUNCTION DB2INST1.FX_F_${UP} TO ROLE FX_R_${UP}`,
      `GRANT EXECUTE ON PROCEDURE DB2INST1.FX_P_${UP} TO ROLE FX_R_${UP}`,
      `GRANT CONNECT ON DATABASE TO ROLE FX_R_${UP}`,
    ],
    teardown: [
      `DROP PROCEDURE DB2INST1.FX_P_${UP}`,
      `DROP FUNCTION DB2INST1.FX_F_${UP}`,
      `DROP TABLE DB2INST1.FX_T_${UP}`,
      `REVOKE CONNECT ON DATABASE FROM ROLE FX_R_${UP}`,
      `DROP ROLE FX_R_${UP}`,
    ],
  },
  {
    dialect: 'clickhouse',
    options: { host: 'localhost', port: 8123, database: 'default', username: 'default', password: 'foxpass' },
    schema: 'default',
    principal: `fx_r_${TAG}`,
    table: `fx_t_${TAG}`,
    routines: { none: 'ClickHouse has no stored procedures, and its SQL functions take no grants.' },
    noGridCells: 'the object grid has no ClickHouse privilege table (cellSupport), so its grants are listed under it',
    wide: { objectType: 'SCHEMA', privilege: 'CREATE TABLE', describedAs: /^CREATE TABLE on schema default$/ },
    setup: [
      `CREATE ROLE fx_r_${TAG}`,
      `CREATE TABLE default.fx_t_${TAG} (id UInt8) ENGINE = Memory`,
      `GRANT SELECT ON default.fx_t_${TAG} TO fx_r_${TAG}`,
      `GRANT CREATE TABLE ON default.* TO fx_r_${TAG}`,
    ],
    teardown: [`DROP TABLE IF EXISTS default.fx_t_${TAG}`, `DROP ROLE IF EXISTS fx_r_${TAG}`],
  },
];

/** Run statements on one connection, naming the one the server rejects. */
async function exec(engine: Engine, statements: string[], opts: { ignoreErrors?: boolean } = {}): Promise<void> {
  const connection = await ConnectionFactory.create(engine.dialect, engine.options, { pooled: false });
  const adapter = getAdapter(engine.dialect);
  try {
    for (const sql of statements) {
      try {
        await adapter.query(connection, sql, []);
      } catch (err) {
        if (opts.ignoreErrors) continue;
        throw new Error(`${engine.dialect} rejected:\n${sql}\n\n${(err as Error).message.split('\n')[0]}`);
      }
    }
  } finally {
    await ConnectionFactory.close(engine.dialect, connection).catch(() => undefined);
  }
}

/** What the Access panel would show for the role: the same probe, filtered to it. */
async function readGrants(engine: Engine): Promise<{ mine: DbPrivilege[]; principals: string[]; warning?: string }> {
  const probed = await probeDbAccess({ dialect: engine.dialect, option: engine.options, schema: engine.schema });
  if (!probed.ok) throw new Error(`${engine.dialect}: ${probed.failure.error}`);
  return {
    mine: privilegesForPrincipal(probed.value.privileges, engine.principal),
    principals: probed.value.principals.map((p) => principalKey(p.name)),
    warning: probed.value.warning,
  };
}

const same = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();
const grantOn = (mine: DbPrivilege[], name: string, privilege: string) =>
  mine.filter((p) => same(p.objectName, name) && same(p.privilege, privilege) && p.state !== 'deny');

const down = new Map<string, string>();
const madeOn = new Set<Engine>();

afterAll(async () => {
  for (const engine of madeOn) await exec(engine, engine.teardown, { ignoreErrors: true });
  await ConnectionFactory.closeAll().catch(() => undefined);
});

describe.runIf(RUN)('access grants on the real engines', () => {
  for (const engine of ENGINES) {
    describe(engine.dialect, () => {
      const skipIfDown = (ctx: { skip: (note?: string) => void }) => {
        const why = down.get(engine.dialect);
        if (why !== undefined) ctx.skip(`${engine.dialect} is not reachable: ${why}`);
      };

      it('is reachable', async (ctx) => {
        try {
          await ConnectionFactory.executeQuery(engine.dialect, engine.options, engine.probe ?? 'SELECT 1');
        } catch (err) {
          down.set(engine.dialect, (err as Error).message.split('\n')[0] ?? 'no answer');
          ctx.skip(`${engine.dialect} is not reachable: ${down.get(engine.dialect)}`);
        }
      });

      it('reads the table, routine and wide grants back as the Grants view shows them', async (ctx) => {
        skipIfDown(ctx);
        madeOn.add(engine);
        await exec(engine, engine.setup);

        const { mine, principals, warning } = await readGrants(engine);
        // The first rung answered: a fallback reads fewer catalogs, and the
        // panel says so, so a working server must not need one.
        expect(warning, 'the privilege ladder fell back').toBeUndefined();
        expect(principals).toContain(principalKey(engine.principal));

        const table = grantOn(mine, engine.table, 'SELECT');
        expect(table.map((p) => p.objectType), 'SELECT on the table').toEqual(['TABLE']);

        const routines = Array.isArray(engine.routines) ? engine.routines : [];
        for (const r of routines) {
          const held = grantOn(mine, r.name, 'EXECUTE');
          expect(held.map((p) => p.objectType), `EXECUTE on the ${r.kind}`).toEqual([r.reportedAs]);
        }

        const wide = mine.filter((p) => p.objectType === engine.wide.objectType && same(p.privilege, engine.wide.privilege));
        expect(wide.length, `${engine.wide.privilege} (${engine.wide.objectType})`).toBeGreaterThan(0);

        // The grid: table and routine rows tick; the wide grant is listed
        // under it rather than dropped.
        const objects = [
          { schema: engine.schema, kind: 'table' as const, name: engine.table },
          ...routines.map((r) => ({ schema: engine.schema, kind: r.kind, name: r.name })),
        ];
        const { held, elsewhere } = splitHeldPrivileges(mine, objects, engine.dialect, engine.schema);
        const cells = (kind: GridObjectKind, name: string) =>
          held.get(`${engine.schema.toLowerCase()}.${kind}.${name.toLowerCase()}`) ?? [];
        const also = elsewhere.map(describeHeldPrivilege);
        if (engine.noGridCells) {
          // Not hidden: the also-holds line names it.
          expect(cells('table', engine.table)).toEqual([]);
          expect(also).toContain(`SELECT on ${engine.schema}.${engine.table}`);
        } else {
          expect(cells('table', engine.table)).toContain('read');
        }
        for (const r of routines) expect(cells(r.kind, r.name)).toContain(`execute-${r.kind}`);
        expect(also).toEqual(expect.arrayContaining([expect.stringMatching(engine.wide.describedAs)]));
      });

      const revokes = Array.isArray(engine.routines)
        ? 'revokes the function (Database Access SQL) and the procedure (Grants grid SQL), and both are gone'
        : `revokes the table grant with the SQL the app writes, and it is gone (no routines: ${engine.routines.none})`;
      it(revokes, async (ctx) => {
        skipIfDown(ctx);
        const before = await readGrants(engine);
        const routines = Array.isArray(engine.routines) ? engine.routines : [];
        const statements: string[] = [];
        const revoked: Array<{ name: string; privilege: string }> = [];

        // Database Access: revoked from the catalog's own row.
        const rows = [
          ...(routines[0] ? grantOn(before.mine, routines[0].name, 'EXECUTE') : grantOn(before.mine, engine.table, 'SELECT')),
          ...(engine.revokeTable ? grantOn(before.mine, engine.table, 'SELECT') : []),
        ];
        expect(rows.length, 'the grant to revoke was not read back').toBeGreaterThan(0);
        for (const row of rows) {
          const built = buildGrantRevokeSql({
            dialect: engine.dialect,
            action: 'revoke',
            privilege: row.privilege,
            objectType: row.objectType,
            objectSchema: row.objectSchema ?? engine.schema,
            objectName: row.objectName,
            grantee: engine.principal,
            granteeKind: 'role',
          });
          if ('error' in built) throw new Error(built.error);
          statements.push(built.sql);
          revoked.push({ name: row.objectName!, privilege: row.privilege });
        }

        // Grants grid: a held procedure box cleared becomes this request.
        const procedure = routines.find((r) => r.kind === 'procedure');
        if (procedure) {
          const built = buildAccessSql(
            {
              principal: { type: 'role', name: engine.principal },
              action: 'revoke',
              permissions: ['execute-procedure'],
              scope: { type: 'routines', schema: engine.schema, routines: [{ name: procedure.name, kind: 'procedure' }] },
            },
            engine.dialect
          );
          if ('error' in built) throw new Error(built.error);
          statements.push(...built.statements.map((st) => st.sql));
          revoked.push({ name: procedure.name, privilege: 'EXECUTE' });
        }

        await exec(engine, statements.map((sql) => sql.replace(/;\s*$/, '')));

        const after = await readGrants(engine);
        for (const { name, privilege } of revoked) {
          expect(grantOn(after.mine, name, privilege), `${privilege} on ${name}`).toEqual([]);
        }
        // Only what was revoked is gone.
        expect(after.mine.length).toBe(before.mine.length - revoked.length);
      });
    });
  }
});
