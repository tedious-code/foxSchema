import { describe, it, expect } from 'vitest';
import { buildUserSql } from './user-sql';
import {
  buildAccessSql,
  invertAccessRequest,
  type GeneratedPermissionSql,
} from './access-sql';
import {
  accessCapabilities,
  availablePermissions,
  highestRisk,
  permissionsForPreset,
  presetForPermissions,
  supportsAccessBuilder,
  type PermissionRequest,
} from './intent';

const user = { type: 'user' as const, name: 'report_user' };

function ok(req: PermissionRequest, dialect: string): GeneratedPermissionSql {
  const r = buildAccessSql(req, dialect);
  if ('error' in r) throw new Error(`${dialect}: ${r.error}`);
  return r;
}
const sqlOf = (r: GeneratedPermissionSql) => r.statements.map((s) => s.sql).join('\n');

describe('PostgreSQL generation', () => {
  it('read on a schema needs USAGE before SELECT — the prerequisite a reader should not have to know', () => {
    const r = ok(
      { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'reporting' } },
      'postgres'
    );
    const sql = sqlOf(r);
    expect(sql).toMatch(/GRANT USAGE ON SCHEMA "reporting" TO "report_user";/);
    expect(sql).toMatch(/GRANT SELECT ON ALL TABLES IN SCHEMA "reporting" TO "report_user";/);
    // USAGE must come first: the SELECT grant is inert without it.
    expect(sql.indexOf('USAGE')).toBeLessThan(sql.indexOf('ALL TABLES'));
  });

  it('revoking SELECT on one table does not strip schema USAGE other grants need', () => {
    const r = ok(
      {
        principal: user,
        action: 'revoke',
        permissions: ['read'],
        scope: { type: 'tables', schema: 'reporting', tables: ['customers'] },
      },
      'postgres'
    );
    const sql = sqlOf(r);
    expect(sql).toMatch(/REVOKE SELECT ON "reporting"\."customers" FROM "report_user";/);
    expect(sql).not.toMatch(/REVOKE USAGE ON SCHEMA/i);
  });

  it('revoking schema-wide access still removes USAGE', () => {
    const r = ok(
      {
        principal: user,
        action: 'revoke',
        permissions: ['read'],
        scope: { type: 'schema', schema: 'reporting' },
      },
      'postgres'
    );
    expect(sqlOf(r)).toMatch(/REVOKE USAGE ON SCHEMA "reporting" FROM "report_user";/);
  });

  it('future tables add ALTER DEFAULT PRIVILEGES, and say whose objects it covers', () => {
    const r = ok(
      {
        principal: user, action: 'grant', permissions: ['read'],
        scope: { type: 'schema', schema: 'reporting' }, includeFutureObjects: true,
      },
      'postgres'
    );
    expect(sqlOf(r)).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA "reporting" GRANT SELECT ON TABLES TO "report_user";/
    );
    // The ownership caveat is the thing that trips people up in production.
    expect(r.warnings.some((w) => /only applies to objects created by the role/i.test(w.message))).toBe(true);
  });

  it('read/write on a schema grants all four verbs in one statement', () => {
    const r = ok(
      {
        principal: user, action: 'grant',
        permissions: ['read', 'insert', 'update', 'delete'],
        scope: { type: 'schema', schema: 'reporting' },
      },
      'postgres'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/);
  });

  it('one statement per table at table scope', () => {
    const r = ok(
      {
        principal: user, action: 'grant', permissions: ['read'],
        scope: { type: 'tables', schema: 'public', tables: ['orders', 'customers'] },
      },
      'postgres'
    );
    expect(r.statements.filter((s) => !s.sql.startsWith('--'))).toHaveLength(3); // USAGE + 2 tables
    expect(sqlOf(r)).toMatch(/ON "public"\."orders"/);
    expect(sqlOf(r)).toMatch(/ON "public"\."customers"/);
  });

  it('says ALTER and DROP are ownership, not privileges — instead of emitting SQL that will not work', () => {
    const r = ok(
      { principal: user, action: 'grant', permissions: ['drop-object'], scope: { type: 'schema', schema: 'app' } },
      'postgres'
    );
    expect(sqlOf(r)).toMatch(/no ALTER or DROP privilege/);
    expect(r.risk).toBe('critical');
  });

  it('revoke mirrors the grant', () => {
    const r = ok(
      { principal: user, action: 'revoke', permissions: ['read'], scope: { type: 'schema', schema: 'reporting' } },
      'postgres'
    );
    expect(sqlOf(r)).toMatch(/REVOKE SELECT ON ALL TABLES IN SCHEMA "reporting" FROM "report_user";/);
    expect(r.warnings.some((w) => /inherited through a role/i.test(w.message))).toBe(true);
  });
});

describe('MySQL generation', () => {
  it('database read uses db.* and notes that future tables are included', () => {
    const r = ok(
      { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'database', database: 'sales' } },
      'mysql'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECT ON `sales`\.\* TO/);
    expect(r.statements[0].explanation).toMatch(/including tables created later/i);
  });

  it('a user@host principal keeps its host', () => {
    const r = ok(
      {
        principal: { type: 'user', name: 'report_user@10.0.0.5' }, action: 'grant',
        permissions: ['read'], scope: { type: 'database', database: 'sales' },
      },
      'mysql'
    );
    expect(sqlOf(r)).toContain(`'report_user'@'10.0.0.5'`);
  });

  it('offers no schema scope — database and schema are one thing', () => {
    expect(accessCapabilities('mysql').schemaScope).toBe(false);
    const r = buildAccessSql(
      { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'sales' } },
      'mysql'
    );
    expect('error' in r && /no schema-level grants/i.test(r.error)).toBe(true);
  });
});

describe('SQL Server generation', () => {
  it('schema read uses SCHEMA:: and explains that future objects are covered', () => {
    const r = ok(
      { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'reporting' } },
      'sqlserver'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECT ON SCHEMA::\[reporting\] TO \[report_user\];/);
    expect(r.statements[0].explanation).toMatch(/including objects added later/i);
  });

  it('table scope targets OBJECT::', () => {
    const r = ok(
      {
        principal: user, action: 'grant', permissions: ['read'],
        scope: { type: 'tables', schema: 'dbo', tables: ['Orders'] },
      },
      'sqlserver'
    );
    expect(sqlOf(r)).toMatch(/ON OBJECT::\[dbo\]\.\[Orders\]/);
  });

  it('azuresql behaves as sqlserver', () => {
    expect(sqlOf(ok(
      { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'reporting' } },
      'azuresql'
    ))).toMatch(/SCHEMA::/);
  });
});

describe('Db2 and Oracle', () => {
  it('Db2 names the grantee as USER or ROLE', () => {
    const r = ok(
      {
        principal: { type: 'user', name: 'REPORT_USER' }, action: 'grant', permissions: ['read'],
        scope: { type: 'tables', schema: 'REPORTING', tables: ['SALES'] },
      },
      'db2'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECT ON TABLE "REPORTING"\."SALES" TO USER "REPORT_USER";/);
  });

  it('Db2 grants schema-wide with its …IN privileges', () => {
    // This used to assert a commented template. Db2 11.1+ has real schema
    // grants; verified against 12.1, they record in SYSCAT.SCHEMAAUTH.
    const r = ok(
      { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'REPORTING' } },
      'db2'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECTIN ON SCHEMA "REPORTING" TO USER/);
  });

  it('Oracle calls connecting CREATE SESSION', () => {
    const r = ok(
      { principal: user, action: 'grant', permissions: ['connect'], scope: { type: 'database', database: 'ORCL' } },
      'oracle'
    );
    expect(sqlOf(r)).toMatch(/GRANT CREATE SESSION TO/);
  });
});

describe('capabilities keep the UI honest', () => {
  it('engines with no GRANT model are excluded outright', () => {
    for (const d of ['sqlite', 'duckdb', 'clickhouse']) {
      expect(supportsAccessBuilder(d)).toBe(false);
    }
  });

  it('postgres-wire engines inherit the postgres model', () => {
    for (const d of ['cockroachdb', 'yugabytedb', 'redshift']) {
      expect(sqlOf(ok(
        { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'app' } },
        d
      ))).toMatch(/GRANT USAGE ON SCHEMA/);
    }
  });

  it('future objects are refused where they cannot be expressed, not silently dropped', () => {
    const r = buildAccessSql(
      {
        principal: user, action: 'grant', permissions: ['read'],
        scope: { type: 'tables', schema: 'dbo', tables: ['Orders'] }, includeFutureObjects: true,
      },
      'sqlserver'
    );
    expect('error' in r).toBe(true);
  });

  it('connect is only offered where it is a real privilege at database scope', () => {
    expect(availablePermissions('postgres', 'database')).toContain('connect');
    expect(availablePermissions('postgres', 'schema')).not.toContain('connect');
    // MySQL has no CONNECT privilege — reaching the server is the account itself.
    expect(availablePermissions('mysql', 'database')).not.toContain('connect');
  });
});

describe('presets and risk', () => {
  it('round-trip: a preset maps to permissions and back', () => {
    for (const p of ['read-only', 'read-write', 'application-writer', 'procedure-executor', 'schema-developer'] as const) {
      expect(presetForPermissions(permissionsForPreset(p))).toBe(p);
    }
  });

  it('application-writer deliberately withholds delete', () => {
    expect(permissionsForPreset('application-writer')).not.toContain('delete');
    expect(permissionsForPreset('read-write')).toContain('delete');
  });

  it('risk climbs with what the permission can destroy', () => {
    expect(highestRisk(['read'])).toBe('low');
    expect(highestRisk(['read', 'insert'])).toBe('elevated');
    expect(highestRisk(['create-object'])).toBe('administrative');
    expect(highestRisk(['drop-object'])).toBe('critical');
  });

  it('grant option outranks whatever it is attached to', () => {
    // Read is low risk; the ability to pass it on to anyone is not.
    expect(highestRisk(['read'], true)).toBe('critical');
  });

  it('destructive permissions raise a danger warning', () => {
    const r = ok(
      { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'app' }, withGrantOption: true },
      'postgres'
    );
    expect(r.warnings.some((w) => w.level === 'danger')).toBe(true);
    expect(sqlOf(r)).toMatch(/WITH GRANT OPTION/);
  });
});

describe('a Tables-scoped request must not widen to schema- or database-wide grants', () => {
  // Trigger: Permission Builder → scope Tables → click "Execute procedures" or
  // "Manage schema", or switch to Tables after those presets. The flat UI hides
  // execute/create checkboxes at Tables scope, but the request still carried
  // them and emitters granted ALL ROUTINES / CREATE ON SCHEMA.

  it('does not grant EXECUTE ON ALL ROUTINES for a PostgreSQL table list', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read', 'execute-function', 'execute-procedure'],
        scope: { type: 'tables', schema: 'app', tables: ['orders'] },
      },
      'postgres'
    );
    const sql = sqlOf(r);
    expect(sql).toMatch(/GRANT SELECT ON "app"\."orders"/);
    expect(sql).not.toMatch(/ALL ROUTINES/i);
    expect(r.warnings.map((w) => w.message).join(' ')).toMatch(/cannot express/i);
  });

  it('does not grant CREATE ON SCHEMA for a PostgreSQL table list', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: permissionsForPreset('schema-developer'),
        scope: { type: 'tables', schema: 'app', tables: ['orders'] },
      },
      'postgres'
    );
    const sql = sqlOf(r);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON "app"\."orders"/);
    expect(sql).not.toMatch(/GRANT CREATE ON SCHEMA/);
  });

  it('still grants schema-wide EXECUTE when the scope really is a schema', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: permissionsForPreset('procedure-executor'),
        scope: { type: 'schema', schema: 'app' },
      },
      'postgres'
    );
    expect(sqlOf(r)).toMatch(/EXECUTE ON ALL ROUTINES IN SCHEMA "app"/);
  });

  it('does not pack EXECUTE into a MySQL per-table grant', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read', 'execute-procedure', 'create-object'],
        scope: { type: 'tables', schema: 'app', tables: ['orders'] },
      },
      'mysql'
    );
    const sql = sqlOf(r);
    expect(sql).toBe("GRANT SELECT ON `app`.`orders` TO 'report_user'@'%';");
  });

  it('does not pack EXECUTE into a SQL Server per-table grant', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read', 'execute-procedure'],
        scope: { type: 'tables', schema: 'dbo', tables: ['orders'] },
      },
      'sqlserver'
    );
    expect(sqlOf(r)).toBe('GRANT SELECT ON OBJECT::[dbo].[orders] TO [report_user];');
  });

  it('does not grant Oracle CREATE TABLE on a Tables-scoped request', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: permissionsForPreset('schema-developer'),
        scope: { type: 'tables', schema: 'DEMO', tables: ['ORDERS'] },
      },
      'oracle'
    );
    const sql = sqlOf(r);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE, ALTER ON "DEMO"\."ORDERS"/);
    expect(sql).not.toMatch(/GRANT CREATE TABLE/);
  });

  it('does not grant SQL Server CREATE TABLE on a Tables-scoped request', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: permissionsForPreset('schema-developer'),
        scope: { type: 'tables', schema: 'dbo', tables: ['orders'] },
      },
      'sqlserver'
    );
    const sql = sqlOf(r);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE, ALTER ON OBJECT::\[dbo\]\.\[orders\]/);
    expect(sql).not.toMatch(/GRANT CREATE TABLE/);
  });

  it('still allows ALTER on a MySQL table (object grid)', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read', 'alter-object'],
        scope: { type: 'tables', schema: 'app', tables: ['orders'] },
      },
      'mysql'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECT, ALTER ON `app`\.`orders`/);
  });
});

describe('identifier safety', () => {
  it.each([
    ['a name with spaces', 'my schema'],
    ['a reserved word', 'select'],
    ['an embedded double quote', 'we"ird'],
    ['a hyphen', 'report-user'],
  ])('quotes %s rather than concatenating it raw', (_label, name) => {
    const r = ok(
      { principal: user, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: name } },
      'postgres'
    );
    const sql = sqlOf(r);
    // The bare identifier must never appear unquoted next to a keyword.
    expect(sql).toMatch(/ON SCHEMA "/);
    expect(sql).not.toMatch(new RegExp(`SCHEMA ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  });

  it('a quote in a principal name cannot break out of the statement', () => {
    const r = ok(
      { principal: { type: 'user', name: 'ev"il' }, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'app' } },
      'postgres'
    );
    // Doubled, so the identifier stays one token.
    expect(sqlOf(r)).toContain('"ev""il"');
  });

  it('rejects an empty principal instead of generating a dangling grant', () => {
    const r = buildAccessSql(
      { principal: { type: 'user', name: '  ' }, action: 'grant', permissions: ['read'], scope: { type: 'schema', schema: 'app' } },
      'postgres'
    );
    expect('error' in r).toBe(true);
  });
});

describe('invertAccessRequest', () => {
  it('flips grant to revoke and drops the grant option', () => {
    const req: PermissionRequest = {
      principal: user, action: 'grant', permissions: ['read'],
      scope: { type: 'schema', schema: 'app' }, withGrantOption: true,
    };
    const inv = invertAccessRequest(req);
    expect(inv.action).toBe('revoke');
    expect(inv.withGrantOption).toBe(false);
    expect(sqlOf(ok(inv, 'postgres'))).toMatch(/REVOKE SELECT ON ALL TABLES/);
    expect(sqlOf(ok(inv, 'postgres'))).not.toMatch(/WITH GRANT OPTION/);
  });

  it('deny inverts to revoke for undo', () => {
    const req: PermissionRequest = {
      principal: user,
      action: 'deny',
      permissions: ['read'],
      scope: { type: 'schema', schema: 'reporting' },
    };
    expect(invertAccessRequest(req).action).toBe('revoke');
  });
});

describe('Phase C — columns, sequences, DENY', () => {
  it('postgres column read uses parenthesized column list', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read'],
        scope: { type: 'columns', schema: 'public', table: 'orders', columns: ['id', 'total'] },
      },
      'postgres'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECT \("id", "total"\) ON "public"\."orders"/);
  });

  it('postgres sequence usage on named sequences', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['use-sequence'],
        scope: { type: 'sequences', schema: 'public', sequences: ['orders_id_seq'] },
      },
      'postgres'
    );
    expect(sqlOf(r)).toMatch(/GRANT USAGE ON SEQUENCE "public"\."orders_id_seq"/);
  });

  it('mysql column grant', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read', 'update'],
        scope: { type: 'columns', schema: 'sales', table: 'orders', columns: ['status'] },
      },
      'mysql'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECT, UPDATE \(`status`\) ON `sales`\.`orders`/);
  });

  it('sql server DENY uses DENY … TO', () => {
    const r = ok(
      {
        principal: user,
        action: 'deny',
        permissions: ['delete'],
        scope: { type: 'tables', schema: 'dbo', tables: ['Orders'] },
      },
      'sqlserver'
    );
    expect(sqlOf(r)).toMatch(/DENY DELETE ON OBJECT::\[dbo\]\.\[Orders\] TO \[report_user\]/);
  });

  it('sql server column deny', () => {
    const r = ok(
      {
        principal: user,
        action: 'deny',
        permissions: ['read'],
        scope: { type: 'columns', schema: 'dbo', table: 'Orders', columns: ['Salary'] },
      },
      'sqlserver'
    );
    expect(sqlOf(r)).toMatch(/DENY SELECT ON OBJECT::\[dbo\]\.\[Orders\] \(\[Salary\]\) TO/);
  });

  it('deny is refused on postgres', () => {
    const r = buildAccessSql(
      {
        principal: user,
        action: 'deny',
        permissions: ['read'],
        scope: { type: 'schema', schema: 'app' },
      },
      'postgres'
    );
    expect('error' in r && /no DENY/i.test(r.error)).toBe(true);
  });

  it('column scope is gated by capability', () => {
    expect(accessCapabilities('postgres').columnScope).toBe(true);
    expect(accessCapabilities('db2').columnScope).toBe(false);
    expect(availablePermissions('postgres', 'columns')).toEqual(['read', 'insert', 'update']);
  });
});

describe('access-sql registry', () => {
  it('aliases azuresql to sqlserver grant shape', () => {
    const req: PermissionRequest = {
      principal: user,
      action: 'grant',
      permissions: ['read'],
      scope: { type: 'tables', schema: 'dbo', tables: ['Orders'] },
    };
    expect(sqlOf(ok(req, 'azuresql'))).toBe(sqlOf(ok(req, 'sqlserver')));
  });

  it('aliases mariadb and tidb to mysql grant shape', () => {
    const req: PermissionRequest = {
      principal: user,
      action: 'grant',
      permissions: ['read'],
      scope: { type: 'tables', schema: 'sales', tables: ['orders'] },
    };
    expect(sqlOf(ok(req, 'mariadb'))).toBe(sqlOf(ok(req, 'mysql')));
    expect(sqlOf(ok(req, 'tidb'))).toBe(sqlOf(ok(req, 'mysql')));
  });

  it('aliases cockroachdb and yugabytedb to postgres grant shape', () => {
    const req: PermissionRequest = {
      principal: user,
      action: 'grant',
      permissions: ['read'],
      scope: { type: 'schema', schema: 'reporting' },
    };
    expect(sqlOf(ok(req, 'cockroachdb'))).toBe(sqlOf(ok(req, 'postgres')));
    expect(sqlOf(ok(req, 'yugabytedb'))).toBe(sqlOf(ok(req, 'postgres')));
  });
});

describe('a commented-out template does not count as granting anything', () => {
  // Reported from a live Oracle test: "read only" at database scope produced a
  // runnable GRANT CREATE SESSION and a commented "repeat for each table"
  // block, with no warning. Pasting it gave the account login and no read
  // access at all. The template was passing itself off as covering SELECT,
  // which silenced the warning built for exactly this case.
  it('warns that Oracle read is not granted at database scope', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['connect', 'read'],
        scope: { type: 'database', database: 'FREEPDB1' },
      },
      'oracle'
    );
    const sql = sqlOf(r);
    expect(sql).toMatch(/GRANT CREATE SESSION/);
    // The only runnable line is the session grant; the rest is a comment.
    const runnable = sql
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('--'));
    expect(runnable).toHaveLength(1);

    const warned = r.warnings.map((w) => w.message).join(' ');
    expect(warned).toMatch(/cannot express read data/i);
    expect(warned).toMatch(/switch the scope to tables/i);
  });

  it('warns the same way on Db2 at database scope', () => {
    // Schema scope now emits a real SELECTIN grant, so the template — and the
    // warning — only remain where there is no schema to name.
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read'],
        scope: { type: 'database', database: 'FOXDB' },
      },
      'db2'
    );
    expect(r.warnings.map((w) => w.message).join(' ')).toMatch(/cannot express read data/i);
  });

  it('warns that PostgreSQL alter and drop are ownership, not grants', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['alter-object', 'drop-object'],
        scope: { type: 'schema', schema: 'reporting' },
      },
      'postgres'
    );
    const warned = r.warnings.map((w) => w.message).join(' ');
    expect(warned).toMatch(/cannot express/i);
    // Not a table privilege, so the "pick tables" advice would be wrong here.
    expect(warned).toMatch(/ownership/i);
  });

  it('still reports nothing when the grant really is expressible', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read'],
        scope: { type: 'tables', schema: 'DEMO_A', tables: ['ORDERS'] },
      },
      'oracle'
    );
    expect(sqlOf(r)).toMatch(/GRANT SELECT ON "DEMO_A"\."ORDERS"/);
    expect(r.warnings.map((w) => w.message).join(' ')).not.toMatch(/cannot express/i);
  });
});

describe('Db2 schema-wide grants', () => {
  // The emitter used to say Db2 had none and emit a commented template.
  // Verified against Db2 12.1: these grant and record in SYSCAT.SCHEMAAUTH.
  it('grants the …IN privileges instead of a template', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read', 'insert', 'update', 'delete'],
        scope: { type: 'schema', schema: 'DEMO_A' },
      },
      'db2'
    );
    expect(sqlOf(r)).toBe('GRANT SELECTIN, INSERTIN, UPDATEIN, DELETEIN ON SCHEMA "DEMO_A" TO USER "report_user";');
    // Nothing is missed, so no caution about an unexpressible privilege.
    expect(r.warnings.map((w) => w.message).join(' ')).not.toMatch(/cannot express/i);
  });

  it('maps execute to EXECUTEIN once, not twice', () => {
    // Both routine permissions map to the same keyword.
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['execute-function', 'execute-procedure'],
        scope: { type: 'schema', schema: 'DEMO_A' },
      },
      'db2'
    );
    expect(sqlOf(r)).toMatch(/GRANT EXECUTEIN ON SCHEMA/);
    expect(sqlOf(r)).not.toMatch(/EXECUTEIN, EXECUTEIN/);
  });

  it('revokes with the same keywords', () => {
    const r = ok(
      {
        principal: user,
        action: 'revoke',
        permissions: ['read'],
        scope: { type: 'schema', schema: 'DEMO_A' },
      },
      'db2'
    );
    expect(sqlOf(r)).toMatch(/REVOKE SELECTIN ON SCHEMA "DEMO_A" FROM USER/);
  });

  it('still explains itself at database scope, where there is no schema to name', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read'],
        scope: { type: 'database', database: 'FOXDB' },
      },
      'db2'
    );
    const runnable = sqlOf(r).split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
    expect(runnable).toHaveLength(0);

    const warned = r.warnings.map((w) => w.message).join(' ');
    expect(warned).toMatch(/cannot express read data/i);
    // The advice has to match the engine. Db2 does have schema-wide grants, so
    // telling the reader it does not would contradict the statement the
    // emitter produces one scope over.
    expect(warned).toMatch(/choose a schema/i);
    expect(warned).not.toMatch(/no schema-wide table grant/i);
  });

  it('tells Oracle readers the opposite, because Oracle really has none', () => {
    const r = ok(
      {
        principal: user,
        action: 'grant',
        permissions: ['read'],
        scope: { type: 'database', database: 'FREEPDB1' },
      },
      'oracle'
    );
    const warned = r.warnings.map((w) => w.message).join(' ');
    expect(warned).toMatch(/no schema-wide table grant/i);
    expect(warned).not.toMatch(/choose a schema/i);
  });
});

describe('engines this tool does not speak for', () => {
  // Verified against Redis 7 and MongoDB 7: both have working account systems.
  // `ACL SETUSER` created a user whose key pattern and command list were then
  // enforced (NOPERM on both a key outside ~fox:* and a command outside +get),
  // and `db.createUser` with a `read` role allowed a find and refused an
  // insert. Telling their users otherwise misinforms them about their own
  // server.
  it('does not claim Redis and MongoDB have no accounts', () => {
    for (const dialect of ['redis', 'mongodb']) {
      const out = buildUserSql(
        { action: 'create', principalType: 'user', name: 'x' } as never,
        dialect
      );
      if (!('error' in out)) throw new Error(`${dialect} should refuse`);
      expect(out.error, dialect).not.toMatch(/has no database accounts/i);
      expect(out.error, dialect).toMatch(/Fox Schema does not manage/i);
      // Name the tool that does, so the refusal is actionable.
      expect(out.error, dialect).toMatch(dialect === 'redis' ? /redis-cli/ : /mongosh/);
    }
  });

  it('still says SQLite has none, because that is true', () => {
    const out = buildUserSql(
      { action: 'create', principalType: 'user', name: 'x' } as never,
      'sqlite'
    );
    if (!('error' in out)) throw new Error('sqlite should refuse');
    expect(out.error).toMatch(/no database accounts/i);
  });

  /**
   * The permission screen is where a Redis or MongoDB reader most needs the
   * pointer, because the permission system is the interesting half of both
   * engines — and it was the one screen that did not give it.
   *
   * Every command named here was run against Redis 7.4 and MongoDB 7. Redis
   * refused a key outside `~fox:*` with NOPERM and a command outside `+get`
   * with NOPERM, so patterns and command lists really are the model. MongoDB's
   * `read` role read a collection and was denied an insert; granting
   * `readWrite` allowed the same insert.
   */
  const refusedGrant = (dialect: string) => {
    const out = buildAccessSql(
      {
        principal: user,
        action: 'grant',
        permissions: ['read'],
        scope: { type: 'schema', schema: 's' },
      },
      dialect
    );
    if (!('error' in out)) throw new Error(`${dialect} should refuse`);
    return out.error;
  };

  it('refuses a grant without offering advice it cannot take', () => {
    // Redis was told it "has no schema-level grants — select individual tables
    // instead". It has no tables either, so that named an action even less
    // available than the one refused.
    for (const dialect of ['redis', 'mongodb']) {
      expect(refusedGrant(dialect), dialect).not.toMatch(/individual tables/i);
    }
  });

  it('names the tool on the permission screen too, not only the account one', () => {
    for (const dialect of ['redis', 'mongodb']) {
      const error = refusedGrant(dialect);
      expect(error, dialect).toMatch(/Fox Schema does not build/i);
      expect(error, dialect).toMatch(dialect === 'redis' ? /redis-cli/ : /mongosh/);
      // Stopping at "Fox Schema has no permission model" left the reader with
      // nothing on the screen they came to for exactly that.
      expect(error, dialect).not.toMatch(/nothing to generate here/i);
    }
    expect(refusedGrant('redis')).toMatch(/ACL SETUSER/);
    expect(refusedGrant('mongodb')).toMatch(/grantRolesToUser/);
  });

  it('promises nothing neither engine can do', () => {
    // Neither can rename an account — `ACL SETUSER … RENAME` is a syntax error
    // and MongoDB answers `no such command: 'renameUser'` — and MongoDB cannot
    // disable one at all: revoking every role still leaves it able to
    // authenticate. Both checked against the running servers.
    for (const dialect of ['redis', 'mongodb']) {
      expect(refusedGrant(dialect), dialect).not.toMatch(/rename/i);
    }
    expect(refusedGrant('mongodb')).not.toMatch(/disable/i);
  });

  it('keeps the plain wording where the engine really has neither', () => {
    // SQLite and DuckDB have no accounts and no grants: the file's owner is
    // the access control, so there is no tool to point at.
    for (const dialect of ['sqlite', 'duckdb']) {
      const error = refusedGrant(dialect);
      expect(error, dialect).toMatch(/no permission model/i);
      expect(error, dialect).not.toMatch(/redis-cli|mongosh/);
    }
  });
});
