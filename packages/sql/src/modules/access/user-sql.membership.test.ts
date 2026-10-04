/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Joining and leaving roles for an account that already exists. Before this,
 * memberships could only be chosen when creating an account; an existing one
 * had no way to change them, and nowhere showed them ticked.
 */
import { describe, expect, it } from 'vitest';
import { buildUserSql } from './user-sql';
import type { UserRequest } from './user-sql.types';

const sqlOf = (dialect: string, extra: Partial<UserRequest>) => {
  const out = buildUserSql({ action: 'alter', alteration: 'membership', principalType: 'user', name: 'app', host: '%', ...extra }, dialect);
  if ('error' in out) throw new Error(out.error);
  return out.statements.map((s) => s.sql);
};

describe('alter membership', () => {
  it('grants the roles joined and revokes the roles left, nothing for the rest', () => {
    expect(sqlOf('postgres', { rolesToAdd: ['writer'], rolesToRemove: ['reader'] })).toEqual([
      'GRANT "writer" TO "app";',
      'REVOKE "reader" FROM "app";',
    ]);
  });

  it('turns joined roles on at login on MySQL and TiDB', () => {
    for (const dialect of ['mysql', 'tidb']) {
      expect(sqlOf(dialect, { rolesToAdd: ['reader@%'] }), dialect).toEqual([
        "GRANT 'reader'@'%' TO 'app'@'%';",
        "SET DEFAULT ROLE ALL TO 'app'@'%';",
      ]);
    }
    // Leaving a role needs no default-role change.
    expect(sqlOf('mysql', { rolesToRemove: ['reader@%'] })).toEqual(["REVOKE 'reader'@'%' FROM 'app'@'%';"]);
  });

  it('leaves MariaDB’s single default role alone, as a comment', () => {
    const sql = sqlOf('mariadb', { rolesToAdd: ['reader'] });
    expect(sql[0]).toBe("GRANT 'reader' TO 'app'@'%';");
    expect(sql[1]).toMatch(/^-- MariaDB keeps one default role/);
  });

  it('says there is nothing to change rather than writing empty SQL', () => {
    const out = buildUserSql(
      { action: 'alter', alteration: 'membership', principalType: 'user', name: 'app', rolesToAdd: [' '], rolesToRemove: [] },
      'postgres'
    );
    expect(out).toEqual({ error: expect.stringMatching(/Nothing to change/) });
  });

  it('treats a role both added and removed as added', () => {
    expect(sqlOf('postgres', { rolesToAdd: ['r'], rolesToRemove: ['r'] })).toEqual(['GRANT "r" TO "app";']);
  });
});
