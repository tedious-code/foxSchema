/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — reverse DDL for triggers, procedures and functions.
 *
 * Drives the whole stored-object path a revert uses: canonicalise a schema,
 * hydrate two versions back out of it, and check the migration that closes the
 * gap. `revert-sql.test.ts` does this for columns; these are the routine and
 * trigger cases, where the reverse statement has to come from the stored
 * definition and signature rather than from a column list.
 */
import { describe, expect, it } from 'vitest';
import type { TableSchema } from '@foxschema/sql';
import { canonicalizeSchema } from './canonical.js';
import { hydrateTableSchemas } from './hydrate.js';
import { buildRevertMigration } from './revert-sql.js';

const FN_V1 =
  'CREATE FUNCTION fn_ship_cost(p_weight decimal(8,2)) RETURNS decimal(8,2) RETURN p_weight * 2';
const FN_V2 =
  'CREATE FUNCTION fn_ship_cost(p_weight decimal(8,2)) RETURNS decimal(8,2) RETURN p_weight * 3';

function fn(definition = FN_V1): TableSchema {
  return {
    name: 'fn_ship_cost',
    objectType: 'FUNCTION',
    definition,
    columns: [],
    indices: [],
    foreignKeys: [],
    parameters: [{ name: 'p_weight', type: 'decimal(8,2)', mode: 'IN' }],
    functionKind: 'scalar',
  };
}

function proc(): TableSchema {
  return {
    name: 'sp_restock',
    objectType: 'PROCEDURE',
    definition: 'CREATE PROCEDURE sp_restock(IN p_qty INT) BEGIN UPDATE shipments SET qty = p_qty; END',
    columns: [],
    indices: [],
    foreignKeys: [],
    parameters: [{ name: 'p_qty', type: 'int', mode: 'IN' }],
  };
}

function shipments(withTrigger: boolean): TableSchema {
  return {
    name: 'shipments',
    objectType: 'TABLE',
    columns: [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'qty', type: 'integer', nullable: true, primaryKey: false },
    ],
    indices: [],
    foreignKeys: [],
    primaryKey: { columns: ['id'] },
    triggers: withTrigger
      ? [
          {
            name: 'trg_shipments_touch',
            timing: 'BEFORE',
            event: 'INSERT',
            definition:
              'CREATE TRIGGER trg_shipments_touch BEFORE INSERT ON shipments FOR EACH ROW EXECUTE FUNCTION touch()',
          },
        ]
      : [],
  };
}

/** A stored version: canonicalised on capture, hydrated back on read. */
function version(tables: TableSchema[]): TableSchema[] {
  return hydrateTableSchemas(canonicalizeSchema(tables));
}

async function revert(
  current: TableSchema[],
  target: TableSchema[],
  dialect = 'postgres'
): Promise<string> {
  const { statements } = await buildRevertMigration(current, target, dialect);
  return statements.join('\n');
}

describe('buildRevertMigration — procedures', () => {
  it('drops a procedure that the target version did not have', async () => {
    const sql = await revert(version([shipments(false), proc()]), version([shipments(false)]));
    expect(sql).toMatch(/DROP PROCEDURE/i);
    expect(sql).toMatch(/sp_restock/i);
  });

  it('carries the stored signature into the drop, so an overload is named', async () => {
    // Postgres cannot drop a routine by bare name. The parameter list has to
    // survive canonicalise → hydrate for this statement to be executable.
    const sql = await revert(version([proc()]), version([]));
    expect(sql).toMatch(/sp_restock\s*\(\s*int\s*\)/i);
  });

  it('re-creates a procedure the target version had, from its stored text', async () => {
    const sql = await revert(version([shipments(false)]), version([shipments(false), proc()]));
    expect(sql).toMatch(/CREATE PROCEDURE/i);
    expect(sql).toMatch(/UPDATE shipments SET qty = p_qty/i);
  });
});

describe('buildRevertMigration — functions', () => {
  it('drops a function that the target version did not have', async () => {
    const sql = await revert(version([fn()]), version([]));
    expect(sql).toMatch(/DROP FUNCTION/i);
    expect(sql).toMatch(/fn_ship_cost/i);
  });

  it('re-creates a dropped function from its stored text', async () => {
    const sql = await revert(version([]), version([fn()]));
    expect(sql).toMatch(/CREATE FUNCTION/i);
    expect(sql).toMatch(/p_weight \* 2/);
  });

  it('restores the target version of a changed body, not the current one', async () => {
    // The direction that is easy to get backwards: current is v2, the user
    // picked v1, so v1's body is what must be written.
    const sql = await revert(version([fn(FN_V2)]), version([fn(FN_V1)]));
    expect(sql).toMatch(/p_weight \* 2/);
    expect(sql).not.toMatch(/p_weight \* 3/);
  });

  it('emits nothing when the two versions hold the same routines', async () => {
    const snapshot = version([shipments(false), proc(), fn()]);
    const { statements, steps } = await buildRevertMigration(snapshot, snapshot, 'postgres');
    expect(statements).toEqual([]);
    expect(steps.filter((s) => !s.skipped && s.statements.length > 0)).toEqual([]);
  });
});

describe('buildRevertMigration — triggers', () => {
  it('drops a trigger the target version did not have, naming its table', async () => {
    const sql = await revert(version([shipments(true)]), version([shipments(false)]));
    expect(sql).toMatch(/DROP TRIGGER/i);
    expect(sql).toMatch(/trg_shipments_touch/i);
    expect(sql).toMatch(/shipments/i);
  });

  it('re-creates a dropped trigger from its stored text', async () => {
    const sql = await revert(version([shipments(false)]), version([shipments(true)]));
    expect(sql).toMatch(/CREATE TRIGGER/i);
    expect(sql).toMatch(/trg_shipments_touch/i);
  });

  it('leaves the table alone when only its trigger moved', async () => {
    const sql = await revert(version([shipments(true)]), version([shipments(false)]));
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ADD COLUMN/i);
  });

  it('drops a trigger on MySQL, which names no table', async () => {
    // The DROP syntax differs per dialect; the stored object is the same.
    const sql = await revert(version([shipments(true)]), version([shipments(false)]), 'mysql');
    expect(sql).toMatch(/DROP TRIGGER/i);
    expect(sql).toMatch(/trg_shipments_touch/i);
  });
});
