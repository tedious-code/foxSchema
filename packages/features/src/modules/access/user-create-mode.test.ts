/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The point of this module is to stop the UI promising something the engine
 * cannot do, so the cases worth asserting are the engines that disagree with
 * the common one: Db2 has no CREATE USER, SQLite has no accounts at all.
 */
import { describe, expect, it } from 'vitest';
import { canCreateAccountSomehow, userCreateModes } from './user-create-mode.js';
import { DIALECT_MAP } from '@foxschema/sql';

const modeOf = (dialect: string, mode: 'sql' | 'cli') =>
  userCreateModes(dialect).options.find((o) => o.mode === mode)!;

describe('every dialect answers, with a reason either way', () => {
  const DIALECTS = Object.keys(DIALECT_MAP).map((d) => d.toLowerCase());

  it('covers the whole registry', () => {
    expect(DIALECTS.length).toBeGreaterThanOrEqual(14);
  });

  it.each(DIALECTS)('%s explains both modes', (dialect) => {
    const out = userCreateModes(dialect);
    expect(out.options).toHaveLength(2);
    for (const o of out.options) {
      // Silence is the one unusable answer: the reader asked a question.
      expect(o.reason.length, `${dialect}/${o.mode}`).toBeGreaterThan(20);
    }
    expect(['sql', 'cli']).toContain(out.preferred);
  });
});

describe('engines that own their accounts in SQL', () => {
  it.each(['postgres', 'mysql', 'mariadb', 'sqlserver', 'oracle', 'clickhouse', 'redshift', 'tidb'])(
    '%s offers both and starts on SQL',
    (dialect) => {
      const out = userCreateModes(dialect);
      expect(modeOf(dialect, 'sql').available).toBe(true);
      expect(modeOf(dialect, 'cli').available).toBe(true);
      expect(out.preferred).toBe('sql');
      expect(out.singleChoice).toBe(false);
    }
  );
});

describe('db2', () => {
  it('cannot create an account in SQL, and says why', () => {
    const sql = modeOf('db2', 'sql');
    expect(sql.available).toBe(false);
    expect(sql.reason).toMatch(/operating system|directory service/i);
  });

  it('starts on the command line, because that is where the account is made', () => {
    const out = userCreateModes('db2');
    expect(out.preferred).toBe('cli');
    expect(modeOf('db2', 'cli').available).toBe(true);
    expect(modeOf('db2', 'cli').reason).toMatch(/operating system/i);
  });

  it('is not offered as a choice, since only one mode works', () => {
    expect(userCreateModes('db2').singleChoice).toBe(true);
  });
});

describe('engines with no accounts at all', () => {
  it.each(['sqlite', 'duckdb'])('%s cannot create one in SQL', (dialect) => {
    expect(modeOf(dialect, 'sql').available).toBe(false);
    expect(modeOf(dialect, 'sql').reason).toMatch(/no database accounts/i);
  });

  it('still offers the OS route, which is the real access control there', () => {
    // File ownership is what decides who may read a SQLite database.
    expect(modeOf('sqlite', 'cli').available).toBe(true);
    expect(canCreateAccountSomehow('sqlite')).toBe(true);
  });
});

describe('an engine nobody has heard of', () => {
  it('offers nothing rather than guessing', () => {
    const out = userCreateModes('nonesuch');
    expect(out.options.every((o) => !o.available)).toBe(true);
    expect(canCreateAccountSomehow('nonesuch')).toBe(false);
  });
});
