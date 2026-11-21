import { describe, expect, it } from 'vitest';
import {
  collapseObjectHistory,
  windowByTime,
  windowGraph,
  DEFAULT_WINDOW_ITEMS,
  MAX_WINDOW_ITEMS,
  type ObjectHistoryPoint,
} from './history';

const at = (createdAt: number, extra: Record<string, unknown> = {}) => ({ createdAt, ...extra });

describe('windowByTime — a render must never be handed unbounded history', () => {
  it('returns newest first', () => {
    const out = windowByTime([at(1), at(3), at(2)]);
    expect(out.items.map((i) => i.createdAt)).toEqual([3, 2, 1]);
  });

  it('drops the oldest when truncating, never the newest', () => {
    // Losing the far past is survivable; losing yesterday is not.
    const out = windowByTime([at(1), at(2), at(3)], { limit: 2 });
    expect(out.items.map((i) => i.createdAt)).toEqual([3, 2]);
  });

  it('reports truncation so the view can say so', () => {
    // Silently showing 2 of 3 and calling it "the history" is the failure.
    const out = windowByTime([at(1), at(2), at(3)], { limit: 2 });
    expect(out.truncated).toBe(true);
    expect(out.matched).toBe(3);
  });

  it('does not claim truncation when everything fits', () => {
    const out = windowByTime([at(1), at(2)], { limit: 5 });
    expect(out.truncated).toBe(false);
    expect(out.matched).toBe(2);
  });

  it('honours an inclusive time window', () => {
    const out = windowByTime([at(10), at(20), at(30)], { from: 20, to: 30 });
    expect(out.items.map((i) => i.createdAt)).toEqual([30, 20]);
    expect(out.matched).toBe(2);
  });

  it('applies a default cap when none is given', () => {
    const many = Array.from({ length: DEFAULT_WINDOW_ITEMS + 50 }, (_, i) => at(i));
    const out = windowByTime(many);
    expect(out.items).toHaveLength(DEFAULT_WINDOW_ITEMS);
    expect(out.truncated).toBe(true);
  });

  it('refuses a limit above the hard ceiling', () => {
    // A caller asking for 50,000 nodes is the crash this exists to prevent.
    const many = Array.from({ length: MAX_WINDOW_ITEMS + 100 }, (_, i) => at(i));
    const out = windowByTime(many, { limit: 50_000 });
    expect(out.limit).toBe(MAX_WINDOW_ITEMS);
    expect(out.items).toHaveLength(MAX_WINDOW_ITEMS);
  });

  it('refuses a nonsense limit rather than returning nothing', () => {
    expect(windowByTime([at(1)], { limit: 0 }).items).toHaveLength(1);
    expect(windowByTime([at(1)], { limit: -5 }).items).toHaveLength(1);
    expect(windowByTime([at(1)], { limit: Number.NaN }).limit).toBe(DEFAULT_WINDOW_ITEMS);
  });

  it('handles an empty history', () => {
    const out = windowByTime([]);
    expect(out).toMatchObject({ items: [], matched: 0, truncated: false });
  });

  it('stays fast on a year of hourly captures', () => {
    // ~8,760 versions. The guard is only useful if applying it is cheap.
    const many = Array.from({ length: 8_760 }, (_, i) => at(i));
    const started = performance.now();
    const out = windowByTime(many, { limit: 200 });
    expect(performance.now() - started).toBeLessThan(200);
    expect(out.items).toHaveLength(200);
    expect(out.matched).toBe(8_760);
  });
});

describe('collapseObjectHistory — the roadmap shows moves, not ticks', () => {
  const point = (
    createdAt: number,
    hash: string | undefined,
    operation: ObjectHistoryPoint['operation']
  ): ObjectHistoryPoint => ({ createdAt, versionId: `v${createdAt}`, hash, operation });

  it('keeps only the versions where the object changed', () => {
    const out = collapseObjectHistory([
      point(1, 'A', 'ADD'),
      point(2, 'A', 'MODIFY'),
      point(3, 'A', 'MODIFY'),
      point(4, 'B', 'MODIFY'),
    ]);
    expect(out.map((p) => p.versionId)).toEqual(['v1', 'v4']);
  });

  it('orders oldest first so a timeline reads forwards', () => {
    const out = collapseObjectHistory([point(3, 'C', 'MODIFY'), point(1, 'A', 'ADD')]);
    expect(out.map((p) => p.createdAt)).toEqual([1, 3]);
  });

  it('keeps a delete followed by a re-add of the same content', () => {
    // The object genuinely went away and came back; collapsing that would
    // misrepresent what happened.
    const out = collapseObjectHistory([
      point(1, 'A', 'ADD'),
      point(2, undefined, 'DELETE'),
      point(3, 'A', 'ADD'),
    ]);
    expect(out.map((p) => p.operation)).toEqual(['ADD', 'DELETE', 'ADD']);
  });

  it('keeps a single point', () => {
    expect(collapseObjectHistory([point(1, 'A', 'ADD')])).toHaveLength(1);
  });

  it('handles an object with no history', () => {
    expect(collapseObjectHistory([])).toEqual([]);
  });
});

describe('windowGraph — edges need both endpoints', () => {
  const node = (createdAt: number, id: string, parentId: string | null) => ({
    createdAt,
    id,
    parentId,
  });

  it('flags that the chain continues past the oldest returned node', () => {
    // Otherwise the timeline draws a root that is not a root.
    const out = windowGraph([node(1, 'a', null), node(2, 'b', 'a'), node(3, 'c', 'b')], {
      limit: 2,
    });
    expect(out.items.map((n) => n.id)).toEqual(['c', 'b']);
    expect(out.hasEarlier).toBe(true);
  });

  it('does not flag earlier history when the true root is included', () => {
    const out = windowGraph([node(1, 'a', null), node(2, 'b', 'a')], { limit: 5 });
    expect(out.hasEarlier).toBe(false);
  });

  it('reports no earlier history for an empty result', () => {
    expect(windowGraph([], {}).hasEarlier).toBe(false);
  });
});
