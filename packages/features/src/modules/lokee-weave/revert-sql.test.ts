/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { TableSchema } from '@foxschema/sql';
import { canonicalizeObject } from './canonical.js';
import { hydrateTableSchemas } from './hydrate.js';
import { buildRevertMigration } from './revert-sql.js';

function table(columns: Array<[string, string, boolean?]>): TableSchema {
  return {
    name: 'customer',
    objectType: 'TABLE',
    columns: columns.map(([name, type, nullable]) => ({
      name,
      type,
      nullable: nullable ?? true,
      primaryKey: name === 'id',
    })),
    indices: [],
    foreignKeys: [],
    primaryKey: { columns: ['id'] },
  };
}

describe('buildRevertMigration', () => {
  it('emits DROP COLUMN when reverting a later add', async () => {
    const v1 = table([
      ['id', 'integer', false],
      ['email', 'varchar(100)'],
    ]);
    const v2 = table([
      ['id', 'integer', false],
      ['email', 'varchar(100)'],
      ['phone', 'varchar(20)'],
    ]);
    const current = hydrateTableSchemas(canonicalizeObject(v2));
    const target = hydrateTableSchemas(canonicalizeObject(v1));
    const { statements } = await buildRevertMigration(current, target, 'postgres');
    const sql = statements.join('\n').toLowerCase();
    expect(sql).toMatch(/drop column/i);
    expect(sql).toMatch(/phone/i);
  });

  it('emits nothing when the snapshots already match', async () => {
    const snap = table([
      ['id', 'integer', false],
      ['email', 'varchar(100)'],
    ]);
    const tables = hydrateTableSchemas(canonicalizeObject(snap));
    const { statements, steps } = await buildRevertMigration(tables, tables, 'postgres');
    expect(statements).toEqual([]);
    expect(steps.filter((s) => !s.skipped && s.statements.length > 0)).toEqual([]);
  });
});
