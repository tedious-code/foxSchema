/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether Execute may run the migration, and why not.
 *
 * Two answers that must agree: the reason shown on the button, most severe and
 * least self-service first, and whether the button takes a click at all. They
 * used to be two hand-kept lists in the panel. They differ on purpose in one
 * place: a missing foreign-key target or an unacknowledged narrowing change
 * blocks the run, but the button stays clickable, so the click can open the
 * dialog that resolves it.
 */

export interface ExecuteGateInput {
  canMigrate: boolean;
  /** Compare, migration or a finished run in progress or on screen. */
  busy: boolean;
  includedCount: number;
  targetConnected: boolean;
  missingFkTargets: number;
  unresolvedDropDeps: number;
  narrowingUnacked: boolean;
  destructiveDropsUnacked: boolean;
  mysqlRoutineRiskUnacked: boolean;
  /** Whether a commit is required is not known yet (the Git repositories have not loaded). */
  gitPending: boolean;
  gitLoadFailed: boolean;
  commitRequired: boolean;
  /** Committed, and the plan unchanged since. */
  planIsCommitted: boolean;
}

export interface ExecuteGate {
  /** What to tell the person; null when nothing blocks. */
  reason: string | null;
  /** The button refuses clicks. */
  disabled: boolean;
}

export function executeGate(i: ExecuteGateInput): ExecuteGate {
  const commitBlocks = i.commitRequired && !i.planIsCommitted;
  const reason =
    !i.canMigrate ? 'Your role cannot execute migrations'
    : i.includedCount === 0 ? 'No objects selected for deployment'
    : !i.targetConnected ? 'Target connection is not healthy — reconnect before deploying'
    : i.missingFkTargets > 0 ? `${i.missingFkTargets} foreign key(s) reference a table that won't exist in the target — resolve the conflicts below`
    : i.unresolvedDropDeps > 0 ? `${i.unresolvedDropDeps} dependent object(s) would break — resolve the conflicts below`
    : i.narrowingUnacked ? 'Acknowledge the narrowing type changes below before deploying'
    : i.destructiveDropsUnacked ? 'Acknowledge the destructive drops below before deploying'
    : i.mysqlRoutineRiskUnacked ? 'Acknowledge the MySQL binlog privilege risk below before deploying'
    : i.gitPending
      ? i.gitLoadFailed
        ? 'Could not check whether migrations must be committed to Git first'
        : 'Checking whether migrations must be committed to Git first'
    : commitBlocks ? 'This install runs only committed migrations — commit the plan to Git first'
    : null;
  const disabled =
    !i.canMigrate ||
    i.busy ||
    i.includedCount === 0 ||
    !i.targetConnected ||
    i.unresolvedDropDeps > 0 ||
    i.destructiveDropsUnacked ||
    i.mysqlRoutineRiskUnacked ||
    i.gitPending ||
    commitBlocks;
  return { reason, disabled };
}
