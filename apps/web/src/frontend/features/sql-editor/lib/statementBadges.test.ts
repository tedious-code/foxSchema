/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '@/shared/lib/sql-splitter';
import type { SqlVariable } from '@/shared/lib/sql-variables';
import { statementBadge, statementCopyText, statementTitle } from './statementBadges';

const one = (sql: string) => splitSqlStatements(sql)[0]!;

describe('statementBadge', () => {
  it('marks a Safe-mode write, and whether it has a WHERE', () => {
    expect(statementBadge(one('UPDATE t SET a = 1 WHERE id = 2;'), true).dml).toEqual({ badge: 'UPD', noWhere: false });
    expect(statementBadge(one('DELETE FROM t;'), true).dml).toEqual({ badge: 'DEL', noWhere: true });
    expect(statementBadge(one('SELECT * FROM t;'), true).dml).toBeNull();
  });

  it('marks nothing with Safe mode off, nor for a code cell', () => {
    expect(statementBadge(one('DELETE FROM t;'), false).dml).toBeNull();
    const cell = statementBadge(one('-- @js\nreturn [];\n-- @end'), true);
    expect(cell).toEqual({ codeKind: 'js', dml: null });
  });
});

describe('statementTitle', () => {
  it('says which cell, its kind, and the warning', () => {
    expect(statementTitle(1, { codeKind: null, dml: { badge: 'DEL', noWhere: true } })).toMatch(
      /^In \[2\] · SQL · DEL: no WHERE — may affect all rows\./
    );
    expect(statementTitle(0, { codeKind: 'node', dml: null })).toMatch(/^In \[1\] · Node\.js code cell\./);
  });
});

describe('statementCopyText', () => {
  const vars: SqlVariable[] = [
    { id: '1', name: 'id', kind: 'scalar', value: 42, updatedAt: 0 },
    { id: '2', name: 'token', kind: 'scalar', value: 'hunter2', secret: true, updatedAt: 0 },
  ];

  it('fills in variables and masks secrets', () => {
    const out = statementCopyText('SELECT * FROM t WHERE id = ${{id}} AND k = ${{token}};', vars);
    expect(out.hasVars).toBe(true);
    expect(out.sql).toContain('id = 42');
    expect(out.sql).not.toContain('hunter2');
    expect(out.sql).toContain('(secret)');
  });

  it('returns the text as written when there are no variables', () => {
    expect(statementCopyText('SELECT 1;', vars)).toEqual({ sql: 'SELECT 1;', hasVars: false });
  });

  it('says why when a variable is not defined', () => {
    expect(statementCopyText('SELECT ${{missing}};', vars).error).toMatch(/Undefined variable: missing/);
  });
});
