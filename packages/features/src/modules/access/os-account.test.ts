/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * OS-account steps per dialect.
 *
 * The rule these all serve: an OS account is offered only where the engine can
 * actually authenticate against one. Suggesting a Linux login that no database
 * will ever consult is worse than saying nothing, so "not applicable" carries a
 * reason and is asserted as carefully as the steps themselves.
 */
import { describe, expect, it } from 'vitest';
import { osAccountSteps } from './os-account.registry.js';
import { DIALECT_MAP } from '@foxschema/sql';
import type { OsAccountContext } from './os-account.types.js';

const ctx = (over: Partial<OsAccountContext> = {}): OsAccountContext => ({
  name: 'app_user',
  runMode: 'server',
  ...over,
});

const sqlOf = (dialect: string, over: Partial<OsAccountContext> = {}) =>
  osAccountSteps(dialect, ctx(over))
    .statements.map((s) => s.sql)
    .join('\n');

describe('every dialect answers', () => {
  const DIALECTS = Object.keys(DIALECT_MAP).map((d) => d.toLowerCase());

  it('covers the whole registry', () => {
    expect(DIALECTS.length).toBeGreaterThanOrEqual(14);
  });

  it.each(DIALECTS)('%s gives a reason either way', (dialect) => {
    const out = osAccountSteps(dialect, ctx());
    // Silence is the one unacceptable answer: the user asked a question.
    expect(out.rationale.length, dialect).toBeGreaterThan(20);
    if (!out.applicable) expect(out.statements, dialect).toEqual([]);
    else expect(out.statements.length, dialect).toBeGreaterThan(0);
  });

  it.each(['sqlserver', 'azuresql', 'clickhouse', 'redshift', 'cockroachdb'])(
    '%s says an OS account would do nothing',
    (dialect) => {
      const out = osAccountSteps(dialect, ctx());
      expect(out.applicable).toBe(false);
      expect(out.statements).toEqual([]);
    }
  );

  it.each(['postgres', 'mysql', 'mariadb', 'tidb', 'oracle', 'sqlite', 'duckdb'])(
    '%s offers steps, because it can authenticate against the OS',
    (dialect) => {
      const out = osAccountSteps(dialect, ctx({ database: '/tmp/demo.db' }));
      expect(out.applicable).toBe(true);
      expect(out.statements.some((s) => s.sql.includes('useradd'))).toBe(true);
    }
  );
});

describe('the rationale names the mechanism', () => {
  it.each([
    ['postgres', /peer/i],
    ['mysql', /auth_socket/i],
    ['mariadb', /auth_socket/i],
    ['oracle', /IDENTIFIED EXTERNALLY/i],
    ['sqlite', /file permissions/i],
  ])('%s explains why', (dialect, pattern) => {
    // A step the reader cannot connect to a mechanism is a step they will
    // either skip or apply where it does nothing.
    expect(osAccountSteps(dialect, ctx()).rationale).toMatch(pattern);
  });

  it('says the OS account is optional where it is', () => {
    for (const d of ['postgres', 'mysql', 'oracle']) {
      expect(osAccountSteps(d, ctx()).rationale, d).toMatch(/does not|Only needed/i);
    }
  });
});

describe('run mode', () => {
  it('uses sudo on a server and docker exec in a container', () => {
    expect(sqlOf('postgres')).toContain('sudo ');
    expect(sqlOf('postgres')).not.toContain('docker');

    const inDocker = sqlOf('postgres', { runMode: 'docker', container: 'foxschema-postgres' });
    expect(inDocker).toContain('docker exec -u 0 foxschema-postgres');
    expect(inDocker).not.toContain('sudo ');
  });

  it('puts -u in the place each transport expects', () => {
    // sudo takes the user before the command; docker before the container.
    expect(sqlOf('postgres')).toContain('sudo -u app_user psql');
    expect(sqlOf('postgres', { runMode: 'docker', container: 'pg' })).toContain(
      'docker exec -u app_user pg psql'
    );
  });

  it('asks for a container rather than emitting a broken command', () => {
    const out = osAccountSteps('postgres', ctx({ runMode: 'docker' }));
    expect(out.applicable).toBe(false);
    expect(out.rationale).toMatch(/container name/i);
  });

  it('refuses a container name that is not one', () => {
    const out = osAccountSteps('postgres', ctx({ runMode: 'docker', container: 'pg; rm -rf /' }));
    expect(out.applicable).toBe(false);
  });
});

describe('account name', () => {
  it('refuses a name Linux could not hold, and says the account still works', () => {
    const out = osAccountSteps('postgres', ctx({ name: 'Report User!' }));
    expect(out.applicable).toBe(false);
    expect(out.rationale).toMatch(/still works/i);
  });

  it('lower-cases, because the engines compare the names literally', () => {
    expect(sqlOf('postgres', { name: 'App_User' })).toContain('useradd -m -s /bin/bash app_user');
  });
});

describe('sqlite', () => {
  it('sets ownership of the file, which is the actual access control', () => {
    const sql = sqlOf('sqlite', { database: '/srv/data/demo.db' });
    // Quoted: the path is one shell word. `--` so a leading `-` is not a flag.
    expect(sql).toContain("chown app_user -- '/srv/data/demo.db'");
  });

  it('quotes the path so spaces and metacharacters cannot become shell', () => {
    // Unquoted, a space splits chown's operands and `$(id)` runs when pasted.
    const evil = "/srv/app data/x$(id).db";
    const sql = sqlOf('sqlite', { database: evil });
    expect(sql).toContain("chown app_user -- '/srv/app data/x$(id).db'");
    expect(sql).toContain("ls -l '/srv/app data/x$(id).db'");
    // The raw path must not appear outside quotes.
    expect(sql).not.toMatch(/chown app_user -- \/srv\/app data/);
    expect(sql).not.toMatch(/ls -l \/srv\/app data/);
  });

  it('refuses a path with a line break rather than emitting a broken command', () => {
    const out = osAccountSteps('sqlite', ctx({ database: '/tmp/x\ny.db' }));
    // useradd still applies; only ownership is withheld.
    expect(out.applicable).toBe(true);
    expect(out.statements.some((s) => s.sql.includes('useradd'))).toBe(true);
    expect(out.statements.some((s) => /line break/i.test(s.explanation))).toBe(true);
    expect(out.statements.some((s) => s.sql.includes('chown'))).toBe(false);
  });

  it('mentions the directory, because the journal is written beside the file', () => {
    const out = osAccountSteps('sqlite', ctx({ database: '/srv/data/demo.db' }));
    expect(out.statements.some((s) => /journal/i.test(s.explanation))).toBe(true);
  });

  it('says so when no file is known yet rather than chowning nothing', () => {
    const sql = sqlOf('sqlite');
    expect(sql).not.toContain('chown app_user \n');
    expect(sql).toMatch(/Choose the database file first/);
  });
});

describe('db2 is not here', () => {
  it('defers to the full Db2 procedure', () => {
    // Db2's OS account is not an optional extra — it is the account, and
    // buildDb2OsUserInstructions emits the whole thing including GRANT CONNECT.
    const out = osAccountSteps('db2', ctx());
    expect(out.applicable).toBe(false);
    // And says why it is absent — Db2 needs the OS account more than anyone,
    // so a generic "we do not know" would read as the opposite of the truth.
    expect(out.rationale).toMatch(/Add user \(OS\)/);
    expect(out.rationale).not.toMatch(/does not know/i);
  });
});
