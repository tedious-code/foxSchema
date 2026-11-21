import { describe, it, expect } from 'vitest';
import { diffAccessDesired, buildAccessReconciliationSql } from './access-diff';
import type { DbPrivilege } from './db-access';
import type { AccessDesiredState } from './intent';

const priv = (p: Partial<DbPrivilege> & { grantee: string; privilege: string }): DbPrivilege => ({
  objectType: 'TABLE',
  objectSchema: 'reporting',
  objectName: 'customers',
  grantable: false,
  grantor: null,
  state: 'grant',
  ...p,
});

describe('diffAccessDesired', () => {
  it('reports missing grants when catalog has no matching row', () => {
    const desired: AccessDesiredState = {
      principal: { type: 'user', name: 'report_user' },
      requests: [
        {
          principal: { type: 'user', name: 'report_user' },
          action: 'grant',
          permissions: ['read'],
          scope: { type: 'tables', schema: 'reporting', tables: ['customers'] },
        },
      ],
    };
    const result = diffAccessDesired(desired, []);
    expect(result.summary.missing).toBeGreaterThan(0);
    expect(result.entries.some((e) => e.status === 'missing')).toBe(true);
  });

  it('reports match when catalog has the privilege', () => {
    const desired: AccessDesiredState = {
      principal: { type: 'user', name: 'report_user' },
      requests: [
        {
          principal: { type: 'user', name: 'report_user' },
          action: 'grant',
          permissions: ['read'],
          scope: { type: 'tables', schema: 'reporting', tables: ['customers'] },
        },
      ],
    };
    const catalog = [
      priv({
        grantee: 'report_user',
        privilege: 'SELECT',
        objectSchema: 'reporting',
        objectName: 'customers',
      }),
    ];
    const result = diffAccessDesired(desired, catalog);
    expect(result.summary.match).toBeGreaterThan(0);
  });

  it('reports extra privileges not in desired state', () => {
    const desired: AccessDesiredState = {
      principal: { type: 'user', name: 'report_user' },
      requests: [],
    };
    const catalog = [
      priv({ grantee: 'report_user', privilege: 'DELETE', objectName: 'orders' }),
    ];
    const result = diffAccessDesired(desired, catalog);
    expect(result.summary.extra).toBe(1);
  });
});

describe('buildAccessReconciliationSql', () => {
  it('generates grant SQL for missing entries', () => {
    const diff = diffAccessDesired(
      {
        principal: { type: 'user', name: 'report_user' },
        requests: [
          {
            principal: { type: 'user', name: 'report_user' },
            action: 'grant',
            permissions: ['read'],
            scope: { type: 'schema', schema: 'reporting' },
          },
        ],
      },
      []
    );
    const sql = buildAccessReconciliationSql(diff, 'postgres');
    expect('error' in sql).toBe(false);
    if (!('error' in sql)) {
      expect(sql.statements.some((s) => /GRANT/i.test(s.sql))).toBe(true);
    }
  });

  it('returns a message when already in sync', () => {
    const diff = diffAccessDesired(
      {
        principal: { type: 'user', name: 'report_user' },
        requests: [
          {
            principal: { type: 'user', name: 'report_user' },
            action: 'grant',
            permissions: ['read'],
            scope: { type: 'tables', schema: 'reporting', tables: ['customers'] },
          },
        ],
      },
      [
        priv({
          grantee: 'report_user',
          privilege: 'SELECT',
          objectSchema: 'reporting',
          objectName: 'customers',
        }),
      ]
    );
    const sql = buildAccessReconciliationSql(diff, 'postgres');
    expect('error' in sql).toBe(true);
    if ('error' in sql) {
      expect(sql.error).toMatch(/matches the catalog/i);
    }
  });

  it('does not treat a single table ACL as a completed schema-wide grant', () => {
    // One table SELECT must not mark schema-wide read/write as matched —
    // reconciliation would otherwise emit nothing while most tables stay locked.
    const desired: AccessDesiredState = {
      principal: { type: 'user', name: 'alice' },
      requests: [
        {
          principal: { type: 'user', name: 'alice' },
          action: 'grant',
          permissions: ['read', 'insert', 'update', 'delete'],
          scope: { type: 'schema', schema: 'public' },
        },
      ],
    };
    const catalog: DbPrivilege[] = [
      priv({
        grantee: 'alice',
        privilege: 'SELECT',
        objectSchema: 'public',
        objectName: 'orders',
      }),
    ];
    const diff = diffAccessDesired(desired, catalog);
    expect(diff.summary.missing).toBeGreaterThan(0);
    expect(diff.summary.match).toBe(0);
    // Existing table ACLs covered by the schema desire are not "extra".
    expect(diff.summary.extra).toBe(0);
    const sql = buildAccessReconciliationSql(diff, 'postgres');
    expect('error' in sql).toBe(false);
    if (!('error' in sql)) {
      expect(sql.statements.some((s) => /GRANT/i.test(s.sql))).toBe(true);
      expect(sql.statements.every((s) => !/REVOKE/i.test(s.sql))).toBe(true);
    }
  });

  it('suppresses per-table extras under a schema-wide desire without false match', () => {
    // Engines expand GRANT … ON ALL TABLES into table ACL rows. Those rows
    // must not become REVOKE targets, but sparse/complete table coverage still
    // cannot prove the schema desire is done — keep it missing so GRANT runs.
    const desired: AccessDesiredState = {
      principal: { type: 'user', name: 'alice' },
      requests: [
        {
          principal: { type: 'user', name: 'alice' },
          action: 'grant',
          permissions: ['read'],
          scope: { type: 'schema', schema: 'public' },
        },
      ],
    };
    const catalog: DbPrivilege[] = [
      priv({
        grantee: 'alice',
        privilege: 'SELECT',
        objectSchema: 'public',
        objectName: 'orders',
      }),
      priv({
        grantee: 'alice',
        privilege: 'SELECT',
        objectSchema: 'public',
        objectName: 'items',
      }),
    ];
    const diff = diffAccessDesired(desired, catalog);
    expect(diff.summary.extra).toBe(0);
    expect(diff.summary.missing).toBeGreaterThan(0);
    const sql = buildAccessReconciliationSql(diff, 'postgres');
    expect('error' in sql).toBe(false);
    if (!('error' in sql)) {
      expect(sql.statements.some((s) => /GRANT/i.test(s.sql))).toBe(true);
      expect(sql.statements.every((s) => !/REVOKE/i.test(s.sql))).toBe(true);
    }
  });
});
