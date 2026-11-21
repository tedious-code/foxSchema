/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — what kind of change happened to a container.
 *
 * "Modified" is true of a table whose comment changed and of one that lost a
 * column, and those are not the same news. The graph shows a table once per
 * version, so the node has room for a few characters at most — this reduces a
 * version's child deltas to the handful of kinds worth putting there.
 *
 * A type change is deliberately separate from a column add/drop. Widening
 * `varchar(100)` to `varchar(255)` is routine; narrowing it truncates data, and
 * both are invisible if the node only says a column changed.
 */
import type { ChangeOperation } from './weave.js';
import { objectKeyKind, objectKeyOwner } from './blueprint.js';

export type ObjectChangeKind =
  | 'column'
  | 'type'
  | 'constraint'
  | 'index'
  | 'trigger'
  | 'definition';

/** One child delta, reduced to what the classifier needs. */
export interface ChildChange {
  objectKey: string;
  operation: ChangeOperation;
  /** Current body, when the version has one (absent for DELETE). */
  body?: Record<string, unknown> | undefined;
  /** Body at the previous version, when there was one (absent for ADD). */
  previousBody?: Record<string, unknown> | undefined;
}

/** Display order: the ones a reader cares about most, first. */
export const CHANGE_KIND_ORDER: readonly ObjectChangeKind[] = [
  'type',
  'column',
  'constraint',
  'index',
  'trigger',
  'definition',
];

const KIND_BY_KEY_PREFIX: Record<string, ObjectChangeKind> = {
  column: 'column',
  index: 'index',
  trigger: 'trigger',
  primary_key: 'constraint',
  foreign_key: 'constraint',
};

function typeOf(body: Record<string, unknown> | undefined): string | null {
  const raw = body?.dataType;
  return typeof raw === 'string' ? raw : null;
}

/**
 * Classify one child delta.
 *
 * Returns null for a key that is not a child of a container (a table's own
 * delta, say) — the caller decides what to do with the container itself.
 */
export function classifyChildChange(change: ChildChange): ObjectChangeKind | null {
  const kind = KIND_BY_KEY_PREFIX[objectKeyKind(change.objectKey)];
  if (!kind) return null;
  if (kind !== 'column') return kind;
  // A column that was there before and after, whose declared type moved, is
  // reported as a type change; anything else about it is a column change.
  if (change.operation === 'MODIFY') {
    const before = typeOf(change.previousBody);
    const after = typeOf(change.body);
    if (before !== null && after !== null && before !== after) return 'type';
  }
  return 'column';
}

/**
 * Group child deltas by the container they belong to.
 *
 * Keys are owner names as they appear in an object key (already match-cased),
 * so a caller can look up `table:CUSTOMER` by `CUSTOMER`.
 */
export function changeKindsByOwner(
  changes: readonly ChildChange[]
): Map<string, ObjectChangeKind[]> {
  const byOwner = new Map<string, Set<ObjectChangeKind>>();
  for (const change of changes) {
    const kind = classifyChildChange(change);
    if (!kind) continue;
    const owner = objectKeyOwner(change.objectKey);
    if (!owner) continue;
    const set = byOwner.get(owner) ?? new Set<ObjectChangeKind>();
    set.add(kind);
    byOwner.set(owner, set);
  }
  const out = new Map<string, ObjectChangeKind[]>();
  for (const [owner, set] of byOwner) {
    out.set(
      owner,
      CHANGE_KIND_ORDER.filter((k) => set.has(k))
    );
  }
  return out;
}

/** Short label for a node badge. Kept to one word — the node is ~150px wide. */
export const CHANGE_KIND_LABEL: Record<ObjectChangeKind, string> = {
  type: 'type',
  column: 'cols',
  constraint: 'keys',
  index: 'idx',
  trigger: 'trg',
  definition: 'def',
};

/** Spoken form, for tooltips and screen readers. */
export const CHANGE_KIND_TITLE: Record<ObjectChangeKind, string> = {
  type: 'column data type changed',
  column: 'columns added or removed',
  constraint: 'primary or foreign key changed',
  index: 'indexes changed',
  trigger: 'triggers changed',
  definition: 'definition changed',
};
