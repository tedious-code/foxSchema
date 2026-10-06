/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Execute must run the script the preview showed.
 *
 * `applyMigration` used to plan from the raw compare filtered by object
 * selection alone, while the preview was built through `buildIncludedDiffs`.
 * Every finer choice therefore applied to the preview and not to the run: role
 * member opt-outs and index opt-ins already, and per-column and per-trigger
 * opt-outs once those existed.
 *
 * A migration tool that runs something other than what it showed is the one
 * failure that cannot be defended, so this pins the two together.
 */
import { beforeAll, describe, expect, it, vi, beforeEach } from 'vitest';

const executeMigration = vi.fn();
vi.mock('@/shared/api/schemaApi', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeMigration: (...args: unknown[]) => executeMigration(...args) };
});
vi.mock('@/app/store/useUiStore', () => ({
  useUiStore: { getState: () => ({ bumpLokeeEpoch: vi.fn() }) },
}));
vi.mock('@/shared/components/toast', () => ({ toast: vi.fn() }));

import { useSyncStore } from './useSyncStore';
import { loadSqlGenerator } from './sync-helpers';
import type { TableDiff } from '@/shared/lib/types';

const col = (name: string, status: 'ADDED' | 'UNCHANGED', extra: Record<string, unknown> = {}) =>
  ({
    name,
    status,
    source: { name: name.toLowerCase(), type: 'text', nullable: true, ...extra },
  }) as TableDiff['columnDiffs'][number];

const ordersDiff = {
  tableName: 'ORDERS',
  status: 'MODIFIED',
  objectType: 'TABLE',
  columnDiffs: [col('KEEP_ME', 'ADDED'), col('DROP_ME', 'ADDED')],
  indexDiffs: [],
  foreignKeyDiffs: [],
  triggerDiffs: [
    { name: 'TRG_KEEP', status: 'ADDED' },
    { name: 'TRG_DROP', status: 'ADDED' },
  ],
  sourceTable: { name: 'orders', columns: [] },
} as unknown as TableDiff;

/**
 * The SQL the run would actually send.
 *
 * Steps carry `statements`, not `sql`. Reading the wrong field returned an
 * empty string from every step, which made the negative assertions pass
 * vacuously — so this throws rather than quietly reporting nothing.
 */
function plannedSql(): string {
  const call = executeMigration.mock.calls.at(-1);
  if (!call) throw new Error('executeMigration was never called — no plan to inspect');
  const [, plan] = call as [unknown, { statements?: string[] }[]];
  const sql = plan.flatMap((s) => s.statements ?? []).join('\n');
  if (!sql.trim()) throw new Error('plan produced no statements — the fixture generates nothing');
  return sql;
}

// These tests set a comparison by hand; the app loads the generator with the
// browse or compare that sets one.
beforeAll(async () => {
  await loadSqlGenerator();
});

beforeEach(() => {
  executeMigration.mockReset();
  executeMigration.mockResolvedValue({ ok: true });
  useSyncStore.setState({
    compareResult: { tables: [ordersDiff] } as never,
    syncSelection: { ORDERS: true },
    memberSelection: {},
    indexSelection: {},
    columnSelection: {},
    triggerSelection: {},
    sourceConfig: { dialect: 'postgres', schema: 'public' } as never,
    targetConfig: { dialect: 'postgres', schema: 'public' } as never,
    nonDestructive: false,
  });
});

describe('Execute plans from the same diffs as the preview', () => {
  it('includes both columns when nothing is unticked', async () => {
    await useSyncStore.getState().applyMigration();
    const sql = plannedSql();
    expect(sql).toMatch(/keep_me/i);
    expect(sql).toMatch(/drop_me/i);
  });

  it('leaves out a column that was unticked', async () => {
    useSyncStore.getState().toggleColumnSelection('ORDERS', 'DROP_ME');
    await useSyncStore.getState().applyMigration();

    const sql = plannedSql();
    expect(sql).toMatch(/keep_me/i);
    // The whole point: this used to be in the run but not in the preview.
    expect(sql).not.toMatch(/drop_me/i);
  });

  it('leaves out a trigger that was unticked', async () => {
    useSyncStore.getState().toggleTriggerSelection('ORDERS', 'TRG_DROP');
    await useSyncStore.getState().applyMigration();

    const sql = plannedSql();
    expect(sql).not.toMatch(/TRG_DROP/i);
  });

  it('agrees with the preview about what is in and what is out', () => {
    // Not a text comparison: the preview carries banner comments the plan does
    // not. What has to match is the substance — the same objects included and
    // the same ones left out.
    useSyncStore.getState().toggleColumnSelection('ORDERS', 'DROP_ME');
    useSyncStore.getState().toggleTriggerSelection('ORDERS', 'TRG_DROP');
    const preview = useSyncStore.getState().generatedSql ?? '';

    expect(preview).toMatch(/keep_me/i);
    expect(preview).not.toMatch(/drop_me/i);
    expect(preview).not.toMatch(/TRG_DROP/i);

    return useSyncStore
      .getState()
      .applyMigration()
      .then(() => {
        const sql = plannedSql();
        expect(sql).toMatch(/keep_me/i);
        expect(sql).not.toMatch(/drop_me/i);
        expect(sql).not.toMatch(/TRG_DROP/i);
      });
  });
});
