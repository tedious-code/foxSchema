/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — bounded history for rendering.
 *
 * A long-lived database accumulates versions indefinitely: an hourly capture
 * that finds a change most days reaches four figures within a year. Handing
 * all of them to a timeline or graph is how the view stops responding, so
 * every read here is bounded by a time window and a hard cap, and always
 * reports whether it truncated.
 *
 * Reporting truncation is the point. A view that silently shows the newest 200
 * of 4,000 versions is worse than one that refuses: the user reads "this is
 * the history" and it is not.
 */

/** Anything with a capture time. Callers add their own fields. */
export interface TimePoint {
  createdAt: number;
}

export interface HistoryWindow {
  /** Inclusive lower bound, epoch ms. */
  from?: number;
  /** Inclusive upper bound, epoch ms. */
  to?: number;
  /** Hard cap on returned items. Clamped to [1, MAX_WINDOW_ITEMS]. */
  limit?: number;
}

export interface WindowResult<T> {
  items: T[];
  /** How many fell inside the time window before the cap was applied. */
  matched: number;
  /** True when `matched` exceeded the cap — the caller must say so in the UI. */
  truncated: boolean;
  /** The cap actually used, after clamping. */
  limit: number;
}

/**
 * Ceiling on what any single read can return.
 *
 * Chosen for the renderer, not the database: a few hundred nodes is already
 * more than a person can read, and well under what a browser can lay out
 * without dropping frames. The database could return far more; that is not
 * the constraint that matters.
 */
export const MAX_WINDOW_ITEMS = 500;
export const DEFAULT_WINDOW_ITEMS = 100;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_WINDOW_ITEMS;
  return Math.max(1, Math.min(MAX_WINDOW_ITEMS, Math.floor(limit)));
}

/**
 * Newest-first slice of a time window.
 *
 * Newest-first because truncation must drop the *oldest* items: someone
 * opening a history wants what happened recently, and losing the far past is
 * survivable in a way that losing yesterday is not.
 */
export function windowByTime<T extends TimePoint>(
  items: readonly T[],
  window: HistoryWindow = {}
): WindowResult<T> {
  const limit = clampLimit(window.limit);
  const from = window.from ?? Number.NEGATIVE_INFINITY;
  const to = window.to ?? Number.POSITIVE_INFINITY;

  const matched = items
    .filter((item) => item.createdAt >= from && item.createdAt <= to)
    .sort((a, b) => b.createdAt - a.createdAt);

  return {
    items: matched.slice(0, limit),
    matched: matched.length,
    truncated: matched.length > limit,
    limit,
  };
}

/** One version's effect on a single object. */
export interface ObjectHistoryPoint extends TimePoint {
  versionId: string;
  operation: 'ADD' | 'MODIFY' | 'DELETE';
  hash?: string;
}

/**
 * Collapse a single object's history to the versions where it actually moved.
 *
 * Callers should already be querying only this object's delta rows, so
 * unchanged versions never appear — but a caller that reconstructs state per
 * version can hand us repeats, and rendering `v13–v17 unchanged` as four
 * identical rows is the noise the roadmap exists to remove.
 *
 * A repeated identical hash is dropped. A DELETE followed by an ADD of the
 * same hash is *not*: the object genuinely went away and came back, and
 * hiding that would misrepresent the history.
 */
export function collapseObjectHistory(
  points: readonly ObjectHistoryPoint[]
): ObjectHistoryPoint[] {
  const ordered = [...points].sort((a, b) => a.createdAt - b.createdAt);
  const out: ObjectHistoryPoint[] = [];
  for (const point of ordered) {
    const previous = out[out.length - 1];
    const sameHash =
      previous !== undefined &&
      previous.operation !== 'DELETE' &&
      point.operation !== 'DELETE' &&
      previous.hash === point.hash;
    if (!sameHash) out.push(point);
  }
  return out;
}

export interface GraphNode extends TimePoint {
  id: string;
  parentId: string | null;
}

export interface GraphResult<T extends GraphNode> extends WindowResult<T> {
  /**
   * True when the oldest returned node has a parent that was cut off, so the
   * view can show the chain continuing rather than implying history starts
   * here.
   */
  hasEarlier: boolean;
}

/**
 * Bounded slice of a version chain for the timeline.
 *
 * Edges are only meaningful when both endpoints are present, so the caller is
 * told explicitly whether the chain continues past the oldest node it got.
 * Without that the timeline draws a root that is not a root.
 */
export function windowGraph<T extends GraphNode>(
  nodes: readonly T[],
  window: HistoryWindow = {}
): GraphResult<T> {
  const result = windowByTime(nodes, window);
  const oldest = result.items[result.items.length - 1];
  return {
    ...result,
    hasEarlier: oldest !== undefined && oldest.parentId !== null,
  };
}
