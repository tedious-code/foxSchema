/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — reversal planning for triggers, procedures and functions.
 *
 * `reversal.test.ts` covers columns and tables, where the risk classes come
 * from data. These objects hold none, so every reversal of them is `safe` and
 * carries no data-loss note. That is what keeps the confirm dialog's
 * destructive warning off a revert that only restores a routine body.
 */
import { describe, expect, it } from 'vitest';
import { classifyReversal, planReversal } from './reversal';
import type { CanonicalObject } from './canonical';

const routine = (
  key: string,
  type: CanonicalObject['type'],
  body: Record<string, unknown> = {}
): CanonicalObject => ({ key, type, body: { name: key.split(/[:.]/).pop(), ...body } });

const fn = (body: Record<string, unknown> = {}) =>
  routine('function:FN_SHIP_COST', 'function', { definition: 'RETURN p_weight * 2', ...body });
const proc = (body: Record<string, unknown> = {}) =>
  routine('procedure:SP_RESTOCK', 'procedure', { definition: 'BEGIN END', ...body });
const trigger = (body: Record<string, unknown> = {}) =>
  routine('trigger:SHIPMENTS.TRG_TOUCH', 'trigger', {
    table: 'shipments',
    timing: 'BEFORE',
    event: 'INSERT',
    definition: 'BEGIN END',
    ...body,
  });
const view = () => routine('view:V_SALES', 'view', { definition: 'SELECT 1' });

const column = (): CanonicalObject => ({
  key: 'column:SHIPMENTS.QTY',
  type: 'column',
  body: { name: 'qty', table: 'shipments', dataType: 'integer', nullable: true },
});

const table = (): CanonicalObject => ({
  key: 'table:SHIPMENTS',
  type: 'table',
  body: { name: 'shipments' },
});

const KINDS: Array<[string, () => CanonicalObject]> = [
  ['function', fn],
  ['procedure', proc],
  ['trigger', trigger],
  ['view', view],
];

describe('classifyReversal — objects that hold no rows', () => {
  it.each(KINDS)('drops a %s without a data-loss warning', (_label, make) => {
    const object = make();
    const verdict = classifyReversal(object.key, object, undefined);
    expect(verdict.risk).toBe('safe');
    expect(verdict.summary).toContain('holds no data');
    expect(verdict.dataLoss).toBeUndefined();
  });

  it.each(KINDS)('re-creates a %s without claiming anything was lost', (_label, make) => {
    // Contrast with a table or column, which carries a note saying its rows
    // went when it was dropped. A routine has no rows to mention.
    const object = make();
    const verdict = classifyReversal(object.key, undefined, object);
    expect(verdict.risk).toBe('safe');
    expect(verdict.summary).toContain('re-created');
    expect(verdict.dataLoss).toBeUndefined();
  });

  it.each(KINDS)('restores an earlier %s definition safely', (_label, make) => {
    const object = make();
    const older = { ...object, body: { ...object.body, definition: 'BEGIN /* older */ END' } };
    const verdict = classifyReversal(object.key, object, older);
    expect(verdict.risk).toBe('safe');
    expect(verdict.summary).toContain('definition restored');
    expect(verdict.dataLoss).toBeUndefined();
  });

  it('still treats a dropped table and column as data loss', () => {
    // The contrast that proves the classification reads the object type rather
    // than defaulting everything to safe.
    expect(classifyReversal('table:SHIPMENTS', table(), undefined).risk).toBe('lossy');
    expect(classifyReversal('column:SHIPMENTS.QTY', column(), undefined).risk).toBe('lossy');
  });

  it('labels a table-owned trigger by its full address', () => {
    const verdict = classifyReversal('trigger:SHIPMENTS.TRG_TOUCH', trigger(), undefined);
    expect(verdict.summary).toContain('SHIPMENTS.TRG_TOUCH');
  });

  it('does not compare routine signatures as if they were column types', () => {
    // A routine body has no `dataType`; the column-narrowing path must not run
    // for it, whatever the parameter lists say.
    const wide = fn({ parameters: [{ name: 'p', type: 'varchar(255)', mode: 'IN' }] });
    const narrow = fn({ parameters: [{ name: 'p', type: 'varchar(10)', mode: 'IN' }] });
    const verdict = classifyReversal(wide.key, wide, narrow);
    expect(verdict.risk).toBe('safe');
    expect(verdict.summary).not.toContain('shortens');
  });
});

describe('planReversal — routine-only and mixed plans', () => {
  it('needs no confirmation for a revert that only touches routines and triggers', () => {
    const plan = planReversal([
      { key: 'function:FN_SHIP_COST', current: fn() },
      { key: 'procedure:SP_RESTOCK', target: proc() },
      { key: 'trigger:SHIPMENTS.TRG_TOUCH', current: trigger(), target: trigger({ event: 'UPDATE' }) },
      { key: 'view:V_SALES', current: view(), target: view() },
    ]);
    expect(plan.risk).toBe('safe');
    expect(plan).toMatchObject({ safeCount: 4, lossyCount: 0, blockedCount: 0 });
    expect(plan.verdicts.every((v) => v.dataLoss === undefined)).toBe(true);
  });

  it('leads with the column, not the routines, when both are in one plan', () => {
    // A migration that reverts a procedure and drops a column is a data-loss
    // plan; the routines must not bury the one entry that says so.
    const plan = planReversal([
      { key: 'procedure:SP_RESTOCK', current: proc(), target: proc({ definition: 'BEGIN /* older */ END' }) },
      { key: 'trigger:SHIPMENTS.TRG_TOUCH', current: trigger() },
      { key: 'column:SHIPMENTS.QTY', current: column() },
    ]);
    expect(plan.risk).toBe('lossy');
    expect(plan.verdicts[0]!.key).toBe('column:SHIPMENTS.QTY');
    expect(plan).toMatchObject({ safeCount: 2, lossyCount: 1, blockedCount: 0 });
  });
});
