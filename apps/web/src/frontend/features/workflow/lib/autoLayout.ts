/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Auto-layout for one pipeline on the designer canvas: left to right in the
 * direction records flow. Each pipe goes in the column after its furthest
 * upstream pipe, and each column is ordered by where its upstream pipes sit,
 * so branches fan out and join without crossing more than they must.
 *
 * Saved workflows carry no positions, so this is also how an opened workflow
 * is drawn. Pure and dependency-free: a layout library would cost bundle
 * budget for a DAG that is rarely more than a few dozen pipes.
 */

export interface LayoutNode {
  id: string;
  /** Rendered size when React Flow has measured it; a default otherwise. */
  width?: number;
  height?: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
  /** Output port; orders siblings so `true` sits above `false`, `out` above `rejects`. */
  sourceHandle?: string | null;
}

export interface LayoutOptions {
  /** Horizontal gap between columns, after the widest node in a column. */
  columnGap?: number;
  /** Vertical gap between nodes in a column. */
  rowGap?: number;
  /** Where the first column starts. */
  origin?: { x: number; y: number };
}

const DEFAULT_WIDTH = 190;
const DEFAULT_HEIGHT = 96;

/** Lower sorts first: the "happy" output above the side outputs. */
const PORT_RANK: Record<string, number> = { out: 0, true: 0, false: 1, rejects: 2 };

function portRank(handle: string | null | undefined): number {
  return handle ? (PORT_RANK[handle] ?? 1) : 0;
}

/**
 * Column (depth) of every node: 0 for nodes nothing feeds, otherwise one past
 * the deepest upstream node. Edges that would close a cycle are ignored, so a
 * malformed graph still lays out instead of looping.
 */
function columnsOf(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target) {
      incoming.get(edge.target)!.push(edge.source);
    }
  }

  const column = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // back edge of a cycle
    visiting.add(id);
    let value = 0;
    for (const parent of incoming.get(id) ?? []) {
      if (visiting.has(parent)) continue;
      value = Math.max(value, depth(parent) + 1);
    }
    visiting.delete(id);
    column.set(id, value);
    return value;
  };
  for (const node of nodes) depth(node.id);
  return column;
}

/** Positions (top-left corners) for every node, keyed by node id. */
export function layoutPipeline(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const columnGap = options.columnGap ?? 70;
  const rowGap = options.rowGap ?? 36;
  const origin = options.origin ?? { x: 80, y: 80 };
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  const column = columnsOf(nodes, edges);
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const columns: LayoutNode[][] = [];
  for (const node of nodes) {
    const c = column.get(node.id) ?? 0;
    (columns[c] ??= []).push(node);
  }

  // Order each column by the mean row of its upstream nodes (barycenter), then
  // by output port, then by document order — stable, so re-running is a no-op.
  const row = new Map<string, number>();
  const parents = new Map<string, Array<{ id: string; rank: number }>>();
  for (const edge of edges) {
    const list = parents.get(edge.target) ?? [];
    list.push({ id: edge.source, rank: portRank(edge.sourceHandle) });
    parents.set(edge.target, list);
  }
  columns.forEach((members, c) => {
    if (!members) return;
    const key = (node: LayoutNode): [number, number, number] => {
      const placed = (parents.get(node.id) ?? []).filter(
        (parent) => row.has(parent.id) && (column.get(parent.id) ?? 0) < c,
      );
      if (placed.length === 0) return [Number.POSITIVE_INFINITY, 0, originalIndex.get(node.id)!];
      const mean = placed.reduce((sum, parent) => sum + row.get(parent.id)!, 0) / placed.length;
      const rank = Math.min(...placed.map((parent) => parent.rank));
      return [mean, rank, originalIndex.get(node.id)!];
    };
    const sorted = [...members].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    });
    // Unplaced roots keep document order among themselves.
    sorted.forEach((node, index) => row.set(node.id, index));
    columns[c] = sorted;
  });

  // Columns are centred on one horizontal line, so a short branch sits beside
  // the middle of a tall one rather than hanging off its top.
  const heights = columns.map((members) =>
    (members ?? []).reduce((sum, node) => sum + (node.height ?? DEFAULT_HEIGHT), 0) +
    Math.max(0, (members?.length ?? 0) - 1) * rowGap,
  );
  const tallest = Math.max(...heights);
  let x = origin.x;
  columns.forEach((members, c) => {
    if (!members) return;
    let y = origin.y + (tallest - heights[c]!) / 2;
    let widest = 0;
    for (const node of members) {
      positions.set(node.id, { x, y });
      y += (node.height ?? DEFAULT_HEIGHT) + rowGap;
      widest = Math.max(widest, node.width ?? DEFAULT_WIDTH);
    }
    x += widest + columnGap;
  });
  return positions;
}

/**
 * True when connecting `source` -> `target` would close a cycle within `edges`.
 */
export function wouldCreateCycle(
  edges: ReadonlyArray<Pick<LayoutEdge, 'source' | 'target'>>,
  source: string,
  target: string,
): boolean {
  if (!source || !target) return false;
  if (source === target) return true;
  const nextByNode = new Map<string, string[]>();
  for (const edge of edges) {
    let list = nextByNode.get(edge.source);
    if (!list) {
      list = [];
      nextByNode.set(edge.source, list);
    }
    list.push(edge.target);
  }
  const seen = new Set<string>([target]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const next of nextByNode.get(current) ?? []) {
      if (next === source) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
