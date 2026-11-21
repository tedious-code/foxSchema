/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — separating an object's identity from its shape.
 *
 * Content addressing already stores one row per distinct object, but an object
 * body carries its own name and table, so `id integer not null` in two tables
 * is two rows with near-identical contents. A representative capture held 247
 * column objects across 112 distinct shapes — a 2.2x repeat, and the ratio
 * grows with the schema, because `int not null` is the same declaration
 * everywhere.
 *
 * So the body is stored in two parts: the identity fields, which are unique per
 * object, and the shape, which is shared by every object declared the same way.
 *
 * **The object hash is computed over the whole body and does not change.** This
 * is a storage layout, not a change to identity — otherwise every existing
 * version would need rehashing and all recorded history would break. `mergeBody`
 * must therefore be an exact inverse of `splitBody`; `shape.test.ts` asserts
 * that on real-shaped bodies, and the store re-checks it during the backfill.
 */
import { stableStringify } from './stable-stringify.js';

/**
 * Fields that name *this* object rather than describe its type.
 *
 * `name` and `table` are what make two otherwise identical columns distinct;
 * everything else is the declaration, which is what repeats.
 */
const IDENTITY_KEYS = ['name', 'table'] as const;

export interface SplitBody {
  /** Per-object fields. Small, never shared. */
  identity: Record<string, unknown>;
  /** The reusable declaration. Shared across every object that matches it. */
  shape: Record<string, unknown>;
}

/** Split a canonical body into its per-object and reusable halves. */
export function splitBody(body: Record<string, unknown>): SplitBody {
  const identity: Record<string, unknown> = {};
  const shape: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if ((IDENTITY_KEYS as readonly string[]).includes(key)) identity[key] = value;
    else shape[key] = value;
  }
  return { identity, shape };
}

/**
 * Recombine the halves.
 *
 * Key order is not preserved and must not matter: everything downstream that
 * compares or hashes a body goes through `stableStringify`, which sorts keys.
 */
export function mergeBody(split: SplitBody): Record<string, unknown> {
  return { ...split.shape, ...split.identity };
}

/**
 * Stable address for a shape. Same declaration → same key, so the store can
 * ask "do I already have this shape?" with one lookup.
 */
export function shapeKey(shape: Record<string, unknown>): string {
  return stableStringify(shape);
}

/**
 * True when splitting and recombining returns the original body.
 *
 * The store calls this before writing a split row. A body that does not round
 * trip is stored whole instead, because a wrong body is far worse than a
 * missed dedup — the hash was computed over the original and would no longer
 * match what a later read reconstructs.
 */
export function roundTrips(body: Record<string, unknown>): boolean {
  return stableStringify(mergeBody(splitBody(body))) === stableStringify(body);
}
