import { describe, it, expect } from 'vitest';
import {
  buildAccessReport,
  permissionsForPrivilege,
  principalsWithAccessTo,
  resolveEffectiveAccess,
  resolveRoleChain,
} from './effective';
import type { DbPrincipal, DbPrivilege } from './db-access';

const principal = (name: string, memberOf: string[] = [], members: string[] = []): DbPrincipal => ({
  name, kind: 'user', canLogin: true, memberOf, members,
});

const priv = (p: Partial<DbPrivilege> & { grantee: string; privilege: string }): DbPrivilege => ({
  objectType: 'TABLE', objectSchema: 'reporting', objectName: 'customers',
  grantable: false, grantor: null, state: 'grant', ...p,
});

describe('privilege → intent mapping', () => {
  it('maps the everyday verbs', () => {
    expect(permissionsForPrivilege('SELECT')).toEqual(['read']);
    expect(permissionsForPrivilege('DELETE')).toEqual(['delete']);
  });

  it('EXECUTE covers both routine kinds — engines do not separate them', () => {
    expect(permissionsForPrivilege('EXECUTE')).toEqual(['execute-function', 'execute-procedure']);
  });

  it.each(['ALL', 'ALL PRIVILEGES', 'CONTROL', 'DBADM'])('%s confers everything', (p) => {
    expect(permissionsForPrivilege(p)).toContain('read');
    expect(permissionsForPrivilege(p)).toContain('drop-object');
  });

  it('USAGE grants no data access on its own — the classic false positive', () => {
    // Reporting USAGE as "can read" would tell a reader they have access they
    // do not; schema usage only permits reaching in.
    expect(permissionsForPrivilege('USAGE')).toEqual([]);
  });

  it('is case- and whitespace-insensitive, and ignores what it does not know', () => {
    expect(permissionsForPrivilege('  select ')).toEqual(['read']);
    expect(permissionsForPrivilege('SOME_FUTURE_PRIVILEGE')).toEqual([]);
    expect(permissionsForPrivilege('')).toEqual([]);
  });
});

describe('role chain resolution', () => {
  const people = [
    principal('report_user', ['reporting_reader']),
    principal('reporting_reader', ['base_reader']),
    principal('base_reader', []),
  ];

  it('walks nested roles and records the path to each', () => {
    const chains = resolveRoleChain('report_user', people);
    expect(chains.get('reporting_reader')).toEqual(['reporting_reader']);
    expect(chains.get('base_reader')).toEqual(['reporting_reader', 'base_reader']);
  });

  it('terminates on a membership cycle instead of looping forever', () => {
    // Several engines permit this; an unguarded walk would hang the UI.
    const cyclic = [
      principal('a', ['b']),
      principal('b', ['c']),
      principal('c', ['a']),
    ];
    const chains = resolveRoleChain('a', cyclic);
    expect([...chains.keys()].sort()).toEqual(['b', 'c']);
  });

  it('matches names case-insensitively — Oracle and Db2 fold to upper case', () => {
    const chains = resolveRoleChain('REPORT_USER', [
      principal('report_user', ['REPORTING_READER']),
      principal('reporting_reader', []),
    ]);
    expect(chains.size).toBe(1);
  });

  it('survives a role that is referenced but not listed', () => {
    // A grant can name a role the principal probe did not return.
    const chains = resolveRoleChain('u', [principal('u', ['ghost_role'])]);
    expect(chains.get('ghost_role')).toEqual(['ghost_role']);
  });
});

describe('effective access', () => {
  const people = [
    principal('report_user', ['reporting_reader']),
    principal('reporting_reader', []),
  ];

  it('attributes a direct grant to the principal itself', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [priv({ grantee: 'report_user', privilege: 'SELECT' })],
    });
    const read = r.objects[0].permissions.find((p) => p.permission === 'read')!;
    expect(read.granted).toBe(true);
    expect(read.sources[0]).toMatchObject({ kind: 'direct', via: 'report_user', chain: [] });
  });

  it('attributes an inherited grant to the role it came through', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [priv({ grantee: 'reporting_reader', privilege: 'SELECT' })],
    });
    const read = r.objects[0].permissions.find((p) => p.permission === 'read')!;
    expect(read.granted).toBe(true);
    expect(read.sources[0]).toMatchObject({ kind: 'role', via: 'reporting_reader', chain: ['reporting_reader'] });
  });

  it('ignores grants to unrelated principals', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [priv({ grantee: 'someone_else', privilege: 'SELECT' })],
    });
    expect(r.objects).toHaveLength(0);
  });

  it('DENY beats an inherited grant, whatever order the rows arrive in', () => {
    // SQL Server's rule. Reporting this as granted would promise access the
    // server refuses.
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [
        priv({ grantee: 'reporting_reader', privilege: 'SELECT' }),
        priv({ grantee: 'report_user', privilege: 'SELECT', state: 'deny' }),
      ],
    });
    const read = r.objects[0].permissions.find((p) => p.permission === 'read')!;
    expect(read.granted).toBe(false);
    expect(read.sources.some((s) => s.kind === 'denied')).toBe(true);
    expect(r.warnings.some((w) => /DENY/.test(w))).toBe(true);
  });

  it('DENY recorded before the grant row still wins', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [
        priv({ grantee: 'report_user', privilege: 'SELECT', state: 'deny' }),
        priv({ grantee: 'reporting_reader', privilege: 'SELECT' }),
      ],
    });
    expect(r.objects[0].permissions.find((p) => p.permission === 'read')!.granted).toBe(false);
  });

  it('keeps every route to the same permission, not just the first', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [
        priv({ grantee: 'report_user', privilege: 'SELECT' }),
        priv({ grantee: 'reporting_reader', privilege: 'SELECT' }),
      ],
    });
    const read = r.objects[0].permissions.find((p) => p.permission === 'read')!;
    expect(read.sources.map((s) => s.kind).sort()).toEqual(['direct', 'role']);
  });

  it('filters to one schema when the inspector scopes to it', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people, schema: 'reporting',
      privileges: [
        priv({ grantee: 'report_user', privilege: 'SELECT' }),
        priv({ grantee: 'report_user', privilege: 'SELECT', objectSchema: 'admin', objectName: 'secrets' }),
      ],
    });
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0].schema).toBe('reporting');
  });

  it('summarises across objects — granted anywhere counts', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [
        priv({ grantee: 'report_user', privilege: 'SELECT', objectName: 'orders' }),
        priv({ grantee: 'report_user', privilege: 'INSERT', objectName: 'audit' }),
      ],
    });
    const g = (p: string) => r.summary.find((s) => s.permission === p)!.granted;
    expect(g('read')).toBe(true);
    expect(g('insert')).toBe(true);
    expect(g('delete')).toBe(false);
  });

  it('reports no writes plainly when there are none', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [priv({ grantee: 'report_user', privilege: 'SELECT' })],
    });
    expect(r.findings).toContain('No write privileges detected.');
  });

  it('flags a privilege the principal can pass on', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [priv({ grantee: 'report_user', privilege: 'SELECT', grantable: true })],
    });
    expect(r.findings.some((f) => /pass on to others/i.test(f))).toBe(true);
  });

  it('warns that schema grants hide future objects', () => {
    const r = resolveEffectiveAccess({
      principal: 'report_user', principals: people,
      privileges: [priv({ grantee: 'report_user', privilege: 'SELECT', objectType: 'SCHEMA', objectName: null })],
    });
    expect(r.warnings.some((w) => /created later/i.test(w))).toBe(true);
  });

  it('returns an empty, non-throwing result for a principal with nothing', () => {
    const r = resolveEffectiveAccess({ principal: 'nobody', principals: [], privileges: [] });
    expect(r.objects).toEqual([]);
    expect(r.summary.every((s) => !s.granted)).toBe(true);
  });
});

describe('access report', () => {
  const people = [
    principal('report_user', ['reporting_reader']),
    principal('reporting_reader', []),
    principal('admin_role', []),
    principal('nobody', []),
  ];

  it('classifies each principal by what it can actually do', () => {
    const r = buildAccessReport({
      principals: people,
      privileges: [
        priv({ grantee: 'reporting_reader', privilege: 'SELECT' }),
        priv({ grantee: 'admin_role', privilege: 'DROP' }),
      ],
    });
    const row = (n: string) => r.principals.find((p) => p.principal === n);
    expect(row('report_user')?.accessType).toBe('Read Only');
    expect(row('admin_role')?.accessType).toBe('Full Access');
    // A principal holding nothing is noise in a review table.
    expect(row('nobody')).toBeUndefined();
  });

  it('names the role a principal inherits through, not just "direct"', () => {
    const r = buildAccessReport({
      principals: people,
      privileges: [priv({ grantee: 'reporting_reader', privilege: 'SELECT' })],
    });
    expect(r.principals.find((p) => p.principal === 'report_user')?.source).toBe(
      'Role: reporting_reader'
    );
  });

  it('sorts the riskiest principals to the top — that is what a reviewer opens this for', () => {
    const r = buildAccessReport({
      principals: people,
      privileges: [
        priv({ grantee: 'reporting_reader', privilege: 'SELECT' }),
        priv({ grantee: 'admin_role', privilege: 'DROP' }),
      ],
    });
    expect(r.principals[0].risk).toBe('critical');
  });

  it('raises a finding for a privilege that can be passed on', () => {
    const r = buildAccessReport({
      principals: people,
      privileges: [priv({ grantee: 'admin_role', privilege: 'SELECT', grantable: true })],
    });
    expect(r.findings.some((f) => /pass on/i.test(f.message) && f.severity === 'critical')).toBe(true);
  });

  it('counts roles only among principals that appear, so empty system roles cannot make the user total negative', () => {
    const catalog: DbPrincipal[] = [
      principal('reader'),
      ...Array.from({ length: 6 }, (_, i) => ({
        name: `SYSROLE${i}`,
        kind: 'role' as const,
        canLogin: false,
        memberOf: [] as string[],
        members: [] as string[],
      })),
    ];
    const r = buildAccessReport({
      principals: catalog,
      privileges: [priv({ grantee: 'reader', privilege: 'SELECT' })],
    });
    expect(r.principals.map((p) => p.principal)).toEqual(['reader']);
    expect(r.roleCount).toBe(0);
    expect(r.principals.filter((p) => p.kind === 'user')).toHaveLength(1);
  });

  it('does not count a DENY as a granted privilege', () => {
    const r = buildAccessReport({
      principals: people,
      privileges: [
        priv({ grantee: 'admin_role', privilege: 'SELECT' }),
        priv({ grantee: 'admin_role', privilege: 'DELETE', state: 'deny' }),
      ],
    });
    expect(r.grantedPrivilegeCount).toBe(1);
  });

  it('answers who can reach one object', () => {
    const who = principalsWithAccessTo({
      principals: people,
      privileges: [
        priv({ grantee: 'reporting_reader', privilege: 'SELECT', objectName: 'payments' }),
        priv({ grantee: 'admin_role', privilege: 'ALL', objectName: 'payments' }),
        priv({ grantee: 'admin_role', privilege: 'SELECT', objectName: 'other' }),
      ],
      schema: 'reporting',
      object: 'payments',
    });
    const names = who.map((w) => w.principal).sort();
    // report_user reaches it through its role, which is the whole point — and
    // the role itself holds the grant, so a reviewer should see both.
    expect(names).toEqual(['admin_role', 'report_user', 'reporting_reader']);
  });

  it('matches object names case-insensitively', () => {
    const who = principalsWithAccessTo({
      principals: people,
      privileges: [priv({ grantee: 'admin_role', privilege: 'SELECT', objectName: 'PAYMENTS' })],
      schema: 'reporting',
      object: 'payments',
    });
    expect(who).toHaveLength(1);
  });
});
