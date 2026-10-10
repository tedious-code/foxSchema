/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Execute button's gate: what it says, and whether it takes a click.
 */
import { describe, expect, it } from 'vitest';
import { executeGate, type ExecuteGateInput } from './executeGate';

const ready: ExecuteGateInput = {
  canMigrate: true,
  busy: false,
  includedCount: 3,
  targetConnected: true,
  missingFkTargets: 0,
  unresolvedDropDeps: 0,
  narrowingUnacked: false,
  destructiveDropsUnacked: false,
  mysqlRoutineRiskUnacked: false,
  gitPending: false,
  gitLoadFailed: false,
  commitRequired: false,
  planIsCommitted: false,
};
const gate = (over: Partial<ExecuteGateInput>) => executeGate({ ...ready, ...over });

describe('the Execute gate', () => {
  it('runs a plan with nothing in its way', () => {
    expect(gate({})).toEqual({ reason: null, disabled: false });
  });

  describe('when the install requires a commit', () => {
    it('blocks an uncommitted plan, and says to commit it', () => {
      expect(gate({ commitRequired: true })).toEqual({
        reason: 'This install runs only committed migrations — commit the plan to Git first',
        disabled: true,
      });
    });

    it('runs the plan once it is committed and unchanged', () => {
      expect(gate({ commitRequired: true, planIsCommitted: true })).toEqual({ reason: null, disabled: false });
    });

    it('waits while it is not yet known whether a commit is required', () => {
      expect(gate({ gitPending: true })).toEqual({ reason: 'Checking whether migrations must be committed to Git first', disabled: true });
      expect(gate({ gitPending: true, gitLoadFailed: true }).reason).toMatch(/^Could not check/);
    });
  });

  it('blocks a conflict it can resolve, but keeps the click so the dialog opens', () => {
    for (const over of [{ missingFkTargets: 2 }, { narrowingUnacked: true }] as const) {
      const g = gate(over);
      expect(g.reason, JSON.stringify(over)).not.toBeNull();
      expect(g.disabled, JSON.stringify(over)).toBe(false);
    }
  });

  it('refuses the click for what only the person can fix first', () => {
    for (const over of [
      { canMigrate: false },
      { busy: true },
      { includedCount: 0 },
      { targetConnected: false },
      { unresolvedDropDeps: 1 },
      { destructiveDropsUnacked: true },
      { mysqlRoutineRiskUnacked: true },
    ] as const) {
      expect(gate(over).disabled, JSON.stringify(over)).toBe(true);
    }
  });

  it('names the most severe reason first', () => {
    expect(gate({ canMigrate: false, includedCount: 0, commitRequired: true }).reason).toBe('Your role cannot execute migrations');
    expect(gate({ targetConnected: false, commitRequired: true }).reason).toMatch(/^Target connection/);
    expect(gate({ missingFkTargets: 2, unresolvedDropDeps: 1 }).reason).toMatch(/^2 foreign key/);
  });
});
