/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave graph — DTO to React Flow nodes and edges.
 *
 * Pure and synchronous on purpose: this is where every layout and lineage
 * decision lives, so it can be tested without mounting React Flow. Rendering
 * only reads what this returns.
 *
 * What the picture must communicate: history moves forward, but unchanged
 * content is *reused* rather than copied. So an object that did not change
 * still occupies its lane, joined by a "reused" edge — the graph draws several
 * historical positions pointing at one immutable stored object.
 */
import type { LokeeObjectType } from '@foxschema/ui-shared';
import {
  DEFAULT_HISTORY_OBJECT_TYPES,
  DEFAULT_LAYOUT,
  MAX_VISIBLE_OBJECT_NODES,
  type GraphChangeStatus,
  type GraphLayout,
  type LokeeEdge,
  type LokeeEdgeData,
  type LokeeNode,
  type SchemaObjectNodeData,
  type VersionEdgeStatus,
  type VersionGraphDTO,
  type VersionGraphFilters,
  type VersionGraphObject,
  type VersionGraphVersion,
  type VersionNodeData,
} from './graphTypes';

export interface BuiltGraph {
  // The node union rather than bare `Node`, so `node.type === 'versionNode'`
  // narrows `node.data` at the consumer instead of needing an assertion.
  nodes: LokeeNode[];
  edges: LokeeEdge[];
  /** Object nodes dropped by the node cap; zero when nothing was cut. */
  hiddenByCap: number;
  /** Object columns actually drawn, left to right. */
  columns: string[];
}

/**
 * Declared node sizes, mirroring the widths the node components set in CSS
 * (`nodes.tsx`: `w-[190px]` for a version, `w-[150px]` for an object).
 *
 * These exist for the minimap, which needs a node to report dimensions before
 * it will draw it. Heights are nominal — a node grows to fit its content, and
 * the minimap only ever paints a few-pixel rectangle from them.
 */
const VERSION_NODE_SIZE = { width: 190, height: 114 } as const;
const OBJECT_NODE_SIZE = { width: 150, height: 56 } as const;

/** Newest first, so version 5 sits at the top of the canvas. */
function orderVersions(dto: VersionGraphDTO) {
  return [...dto.versions].sort((a, b) => b.number - a.number);
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function passesVersionFilters(
  version: VersionGraphVersion,
  filters: VersionGraphFilters
): boolean {
  if (filters.versionIds.size > 0 && !filters.versionIds.has(version.id)) return false;
  if (filters.authors.size > 0) {
    const author = version.author?.trim() ?? '';
    if (!author || !filters.authors.has(author)) return false;
  }
  if (filters.dateFrom && dayKey(version.createdAt) < filters.dateFrom) return false;
  if (filters.dateTo && dayKey(version.createdAt) > filters.dateTo) return false;
  return true;
}

function passesFilters(object: VersionGraphObject, filters: VersionGraphFilters): boolean {
  if (filters.objectTypes.size > 0 && !filters.objectTypes.has(object.objectType)) return false;
  if (filters.statuses.size > 0 && !filters.statuses.has(object.status)) return false;
  if (filters.changesOnly && object.status === 'unchanged') return false;
  if (!filters.showDeleted && object.status === 'deleted') return false;
  return true;
}

/**
 * Assign each logical object a permanent column.
 *
 * Ordered by first appearance walking oldest → newest, so a column's position
 * reflects when the object entered the schema and existing columns never shift
 * when something new arrives. Sorting by name instead would reshuffle the
 * whole graph the moment someone added `aaa_audit`.
 */
export function deriveObjectColumns(dto: VersionGraphDTO, visible: VersionGraphObject[]): string[] {
  const keep = new Set(visible.map((o) => o.objectKey));
  const numberOf = new Map(dto.versions.map((v) => [v.id, v.number]));
  const firstSeen = new Map<string, number>();
  for (const object of dto.objects) {
    if (!keep.has(object.objectKey)) continue;
    const n = numberOf.get(object.versionId) ?? 0;
    const current = firstSeen.get(object.objectKey);
    if (current === undefined || n < current) firstSeen.set(object.objectKey, n);
  }
  return [...firstSeen.entries()]
    .sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1))
    .map(([key]) => key);
}

/**
 * Which objects survive the node cap.
 *
 * Changed objects are kept first: a reader who cannot see everything is far
 * better served by what moved than by an arbitrary alphabetical prefix.
 */
function applyCap(objects: VersionGraphObject[], cap: number): {
  kept: VersionGraphObject[];
  hidden: number;
} {
  if (objects.length <= cap) return { kept: objects, hidden: 0 };
  const rank = (s: GraphChangeStatus) => (s === 'unchanged' ? 1 : 0);
  const ordered = [...objects].sort((a, b) => rank(a.status) - rank(b.status));
  return { kept: ordered.slice(0, cap), hidden: objects.length - cap };
}

/** Lineage edge kind between an object's position in two adjacent versions. */
export function edgeStatusFor(
  older: VersionGraphObject | undefined,
  newer: VersionGraphObject
): VersionEdgeStatus {
  if (newer.status === 'deleted') return 'deleted';
  if (older === undefined) return 'created';
  return older.objectHash === newer.objectHash ? 'reused' : 'modified';
}

export function buildVersionGraph(
  dto: VersionGraphDTO,
  filters: VersionGraphFilters,
  layout: GraphLayout = DEFAULT_LAYOUT,
  cap: number = MAX_VISIBLE_OBJECT_NODES
): BuiltGraph {
  const versions = orderVersions(dto).filter((v) => passesVersionFilters(v, filters));
  const versionIdSet = new Set(versions.map((v) => v.id));
  const rowOf = new Map(versions.map((v, i) => [v.id, i]));

  const visible = dto.objects.filter(
    (o) => versionIdSet.has(o.versionId) && passesFilters(o, filters)
  );
  const { kept, hidden } = applyCap(visible, cap);
  const keptSet = new Set(kept.map((o) => `${o.versionId}\x00${o.objectKey}`));

  const columns = deriveObjectColumns(dto, kept);
  const columnOf = new Map(columns.map((key, i) => [key, i]));

  const changeCount = new Map<string, number>();
  for (const o of dto.objects) {
    if (o.status === 'unchanged') continue;
    changeCount.set(o.versionId, (changeCount.get(o.versionId) ?? 0) + 1);
  }

  /**
   * Whether the author is worth a line on every card.
   *
   * It answers "who did this?" only when the versions disagree. On a
   * single-user install it was the same address repeated down the whole
   * column, crowding out the date and the change count that do differ.
   */
  const authors = new Set(versions.map((v) => v.author?.trim()).filter(Boolean));
  const showAuthor = authors.size > 1;

  const nodes: LokeeNode[] = versions.map((version, row) => ({
    id: `version:${version.id}`,
    type: 'versionNode' as const,
    position: { x: layout.versionX, y: row * layout.versionRowHeight },
    draggable: false,
    // The minimap draws nothing without these. React Flow measures the real
    // DOM for the canvas, but it only writes those measurements back through
    // `onNodesChange` — and this graph is fully controlled with no such
    // handler, so from the minimap's side every node had undefined dimensions
    // and it skipped them all, leaving an empty white box. `initialWidth` /
    // `initialHeight` satisfy it without pinning the rendered size, so nodes
    // still grow to fit their content.
    initialWidth: VERSION_NODE_SIZE.width,
    initialHeight: VERSION_NODE_SIZE.height,
    data: {
      versionId: version.id,
      versionNumber: version.number,
      createdAt: version.createdAt,
      rootHash: version.rootHash,
      ...(showAuthor ? { author: version.author } : {}),
      name: version.name,
      description: version.description,
      changeCount: changeCount.get(version.id) ?? 0,
      revertedToNumber: version.revertedToNumber,
      appliedFrom: version.appliedFrom,
    } satisfies VersionNodeData,
  }));

  // Index by key+version so lineage can look up the adjacent-version position
  // without scanning, and so an object missing from a version (it did not
  // exist yet) simply yields undefined rather than a fabricated node.
  const byKeyVersion = new Map<string, VersionGraphObject>();
  for (const o of dto.objects) byKeyVersion.set(`${o.objectKey}\x00${o.versionId}`, o);

  const edges: LokeeEdge[] = [];

  for (const object of kept) {
    const row = rowOf.get(object.versionId);
    const column = columnOf.get(object.objectKey);
    if (row === undefined || column === undefined) continue;

    const older = versions[row + 1];
    const previous = older ? byKeyVersion.get(`${object.objectKey}\x00${older.id}`) : undefined;

    nodes.push({
      id: `object:${object.versionId}:${object.objectKey}`,
      type: object.status === 'deleted' ? 'deletedObjectNode' : 'schemaObjectNode',
      position: {
        x: layout.objectStartX + column * layout.objectColumnWidth,
        y: row * layout.versionRowHeight + layout.objectYOffset,
      },
      draggable: false,
      // See the version node above — without declared dimensions the minimap
      // skips the node entirely.
      initialWidth: OBJECT_NODE_SIZE.width,
      initialHeight: OBJECT_NODE_SIZE.height,
      data: {
        versionId: object.versionId,
        objectKey: object.objectKey,
        name: object.name,
        objectType: object.objectType,
        objectHash: object.objectHash,
        status: object.status,
        previousHash: previous?.objectHash ?? null,
        ...(object.changeKinds ? { changeKinds: object.changeKinds } : {}),
      } satisfies SchemaObjectNodeData,
    });

    // Lineage runs newer → older, matching the arrow direction on screen.
    if (previous && keptSet.has(`${older!.id}\x00${object.objectKey}`)) {
      const status = edgeStatusFor(previous, object);
      edges.push({
        id: `lineage:${object.objectKey}:${object.versionId}:${older!.id}`,
        source: `object:${object.versionId}:${object.objectKey}`,
        target: `object:${older!.id}:${object.objectKey}`,
        type: 'default',
        data: {
          status,
          objectKey: object.objectKey,
          previousHash: previous.objectHash,
          currentHash: object.objectHash,
        } satisfies LokeeEdgeData,
      });
    }
  }

  // Version spine. Solid and unanimated — it is structure, not activity.
  for (let i = 0; i < versions.length - 1; i++) {
    edges.push({
      id: `version:${versions[i]!.id}:${versions[i + 1]!.id}`,
      source: `version:${versions[i]!.id}`,
      target: `version:${versions[i + 1]!.id}`,
      type: 'default',
      data: { status: 'created' } satisfies LokeeEdgeData,
    });
  }

  return { nodes, edges, hiddenByCap: hidden, columns };
}

/**
 * Copy React Flow's measurements from the previous nodes onto freshly built
 * ones with the same ids.
 *
 * Why this has to exist: React Flow decides an edge is drawable in
 * `isNodeInitialized`, which needs the node's `internals.handleBounds`. Those
 * bounds come from measuring the DOM — and `adoptUserNodes` throws them away
 * whenever it is handed a *new* node object, keeping them only when the object
 * still carries `measured`:
 *
 *     if (!userNode.handles) {
 *       return !userNode.measured ? undefined : internalNode?.internals.handleBounds;
 *     }
 *
 * `buildVersionGraph` returns brand-new objects on every filter change, none of
 * which carry `measured`. So every rebuild reset handleBounds, `getEdgePosition`
 * returned null, and each `EdgeWrapper` rendered nothing — the whole graph lost
 * its edges, version spine included, and never got them back. (Re-measurement
 * reports through `onNodesChange`, which this graph did not have.)
 *
 * Carrying the measurements forward keeps the edges on screen across a rebuild
 * instead of dropping them for a frame while React Flow measures again.
 */
export function carryMeasurements<N extends LokeeNode>(
  next: readonly N[],
  previous: readonly N[]
): N[] {
  if (previous.length === 0) return [...next];
  const measuredById = new Map(previous.map((node) => [node.id, node]));
  return next.map((node) => {
    const before = measuredById.get(node.id);
    // Only a real measurement is worth carrying; an unmeasured predecessor
    // would just copy `undefined` over and change nothing.
    if (!before?.measured?.width || !before.measured.height) return node;
    return { ...node, measured: { ...before.measured } };
  });
}

/** Display order for the object-type filter; not every one is always offered. */
const FILTERABLE_TYPES: LokeeObjectType[] = [
  'table',
  'view',
  'mqt',
  'index',
  'column',
  'trigger',
  'function',
  'procedure',
];

/**
 * Only offer types this history actually contains.
 *
 * The full list is the union of every dialect: a SQLite user was being shown
 * MQT — a term only Db2 uses — plus Procedure and Function checkboxes that
 * could never match anything. A filter that cannot change what you see is
 * noise standing between the reader and the ones that can.
 *
 * `active` keeps a control from vanishing under the person using it, but only
 * for types they ticked themselves. The four defaults are not a choice, and
 * honouring them here would have pinned Function and Procedure to every SQLite
 * database in the product — the exact noise this removes.
 */
export function offeredObjectTypes(
  objects: readonly { objectType: LokeeObjectType }[],
  active: ReadonlySet<LokeeObjectType>,
  defaults: readonly LokeeObjectType[] = DEFAULT_HISTORY_OBJECT_TYPES
): LokeeObjectType[] {
  const present = new Set(objects.map((o) => o.objectType));
  const chosen = new Set([...active].filter((t) => !defaults.includes(t)));
  return FILTERABLE_TYPES.filter((t) => present.has(t) || chosen.has(t));
}
