/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — schema version graph.
 *
 * Versions run down the left; each logical object holds one column for its
 * whole life so lineage can be followed by eye. Unchanged objects still occupy
 * their lane, joined by a dashed "reused" edge — the picture shows several
 * historical positions pointing at one immutable stored object, which is what
 * the storage engine actually does.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, GripVertical, Lock, Unlock } from 'lucide-react';
import type { LokeeObjectType } from '@foxschema/ui-shared';
import { OBJECT_STYLES, STATUS_STYLES, objectStyle, statusStyle } from '@/features/lokee-weave/lib/lokeeColors';
import { LOKEE_NODE_TYPES } from './nodes';
import { buildVersionGraph, carryMeasurements, offeredObjectTypes } from './buildGraph';
import { useUiStore } from '@/app/store/uiStore';
import { VersionCompareModal } from './VersionCompareModal';
import {
  DEFAULT_LAYOUT,
  DEFAULT_HISTORY_OBJECT_TYPES,
  EMPTY_FILTERS,
  MAX_VISIBLE_OBJECT_NODES,
  versionDisplayName,
  type GraphChangeStatus,
  type LokeeEdgeData,
  type LokeeNode,
  type SchemaObjectNodeData,
  type VersionGraphDTO,
  type VersionGraphFilters,
  type VersionGraphVersion,
} from './graphTypes';
import {
  clampHistorySidebarWidth,
  loadHistorySidebarOrder,
  loadHistorySidebarWidth,
  moveHistorySidebarSection,
  saveHistorySidebarOrder,
  saveHistorySidebarWidth,
  DEFAULT_HISTORY_SIDEBAR_WIDTH,
  MAX_HISTORY_SIDEBAR_WIDTH,
  MIN_HISTORY_SIDEBAR_WIDTH,
  type HistorySidebarSectionId,
} from './historySidebar';
import { applyGraphHighlight, type GraphSelection } from '../lib/graphHighlight';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export interface LokeeWeavePageProps {
  dto: VersionGraphDTO;
  /** Connection label for the header, e.g. `[postgres] localhost/foxdb`. */
  subtitle?: string;
  onSelectObject?: (selected: SchemaObjectNodeData) => void;
  /**
   * The object the inspector is showing, so the graph can highlight it. Owned
   * by the caller: the inspector's roadmap can move to another version, and the
   * highlight has to follow rather than keep pointing at the clicked card.
   */
  selectedObject?: SchemaObjectNodeData | null;
  /** Clicking empty canvas deselects — the caller closes its inspector. */
  onClearSelection?: () => void;
  /** Persist a version display name / description edit. */
  onSaveVersionMeta?: (
    versionId: string,
    patch: { name: string; description: string }
  ) => Promise<void>;
  /** Shorter header when shown inside Schema Sync. */
  embedded?: boolean;
}

const STATUSES: GraphChangeStatus[] = ['added', 'modified', 'unchanged', 'deleted'];

/** When a schema has this many distinct objects, default to tables-only. */
const AUTO_TABLES_ONLY_AT = 20;

/** Fit the viewport to versions + this many object columns (readable size). */
const FIT_OBJECT_COLUMNS = 5;

function distinctObjectKeys(dto: VersionGraphDTO): number {
  return new Set(dto.objects.map((o) => o.objectKey)).size;
}

/** Edge styling lives here because React Flow styles edges inline, not by class. */
function styleEdges(edges: Edge[]): Edge[] {
  return edges.map((edge) => {
    const data = edge.data as LokeeEdgeData | undefined;
    const isVersionSpine = edge.id.startsWith('version:');
    if (isVersionSpine) {
      return {
        ...edge,
        style: { stroke: 'var(--color-violet-400)', strokeWidth: 2 },
        animated: false,
      };
    }
    const status =
      data?.status === 'reused'
        ? STATUS_STYLES.unchanged!
        : data?.status === 'modified'
          ? STATUS_STYLES.modified!
          : data?.status === 'deleted'
            ? STATUS_STYLES.deleted!
            : STATUS_STYLES.added!;
    return {
      ...edge,
      style: {
        stroke: status.stroke,
        strokeWidth: 1.5,
        strokeDasharray: status.dashed ? '5 4' : undefined,
      },
      animated: false,
    };
  });
}

/**
 * Scroll area for a list that can outgrow its panel.
 *
 * The colours are set inline rather than left to the sheet's `::-webkit-`
 * rules: macOS hides overlay scrollbars until something moves, so a list that
 * scrolls looks exactly like a list that has been cut off. A permanently
 * visible track is the only thing that says "there is more below".
 */
const SCROLL_LIST: React.CSSProperties = {
  scrollbarWidth: 'thin',
  scrollbarColor: '#475569 transparent',
};

export interface SidebarSectionDragProps {
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

const SidebarSection: React.FC<
  {
    /** Filter panels are reorderable; the two fixed panels below them are not. */
    id: HistorySidebarSectionId | 'editVersion' | 'layout';
    title: string;
    children: React.ReactNode;
  } & SidebarSectionDragProps
> = ({ id, title, children, isDragging, isDragOver, onDragStart, onDragOver, onDrop, onDragEnd }) => {
  const reorderable = onDragStart !== undefined;
  return (
  <section
    data-testid={`lokee-sidebar-${id}`}
    onDragOver={onDragOver}
    onDrop={onDrop}
    className={`rounded-lg border bg-slate-900/60 p-2.5 transition ${
      isDragOver ? 'border-cyan-500/60' : 'border-slate-700'
    } ${isDragging ? 'opacity-50' : ''}`}
  >
    <div className="mb-1.5 flex items-center gap-1">
      {/* Only the grip is draggable, not the panel: the panels hold
          checkboxes and date inputs, and making the whole thing a drag source
          turns every mis-aimed click into a drag. */}
      {reorderable && (
      <div
        draggable
        data-testid={`lokee-sidebar-drag-${id}`}
        title="Drag to reorder"
        aria-label={`Reorder ${title}`}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="-ml-1 shrink-0 cursor-grab text-slate-600 hover:text-slate-400 active:cursor-grabbing"
      >
        <GripVertical className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
      </div>
      )}
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</h3>
    </div>
    {children}
  </section>
  );
};

function freshFilters(
  objectTypes: Set<LokeeObjectType> = new Set(DEFAULT_HISTORY_OBJECT_TYPES)
): VersionGraphFilters {
  return {
    ...EMPTY_FILTERS,
    objectTypes,
    changesOnly: true,
    statuses: new Set(),
    versionIds: new Set(),
    authors: new Set(),
  };
}

/**
 * Pin zoom to 1 and park the first version at the top-left. fitView on a wide
 * short strip either shrinks nodes to a speck or leaves a tiny viewport strip.
 */
function FitReadableView({ nodes }: { nodes: Node[] }) {
  const { setViewport } = useReactFlow();
  // Stable key so selection / label edits don't keep resetting the camera.
  const fitKey = (() => {
    const version = nodes.find((n) => n.type === 'versionNode');
    if (!version) return `n${nodes.length}`;
    return `${version.id}:${version.position.x},${version.position.y}:${nodes.length}`;
  })();
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled || nodes.length === 0) return;
      const version = nodes.find((n) => n.type === 'versionNode') ?? nodes[0]!;
      // React Flow viewport: screen = (world * zoom) + {x,y}. Place the first
      // version near the top-left inset of the pane at 100% zoom.
      const zoom = 1;
      const x = -version.position.x * zoom + 24;
      const y = -version.position.y * zoom + 24;
      void setViewport({ x, y, zoom }, { duration: 180 });
    };
    // Wait for layout + node measurement; one frame is often too early.
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(run);
    });
    const fallback = window.setTimeout(run, 150);
    return () => {
      cancelled = true;
      cancelAnimationFrame(outerRaf);
      cancelAnimationFrame(innerRaf);
      window.clearTimeout(fallback);
    };
  }, [fitKey, nodes, setViewport]);
  return null;
}

export const LokeeWeavePage: React.FC<LokeeWeavePageProps> = ({
  dto,
  subtitle,
  onSelectObject,
  selectedObject,
  onClearSelection,
  onSaveVersionMeta,
  embedded = false,
}) => {
  // Deliberately independent of the Original/Target pickers. Driving this
  // filter from them hid every version between the two sides — pick "Version 1"
  // as Original and Version 2 silently vanished from the graph — so the history
  // overview changed under the reader as a side effect of choosing what to
  // compare. The pickers choose the diff; the graph shows the history; the
  // checkboxes below are the only thing that filters it.
  const [filters, setFilters] = useState<VersionGraphFilters>(freshFilters);
  const isLight = useUiStore((s) => s.resolvedMode) === 'light';
  const [locked, setLocked] = useState(true);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  const selectedVersion: VersionGraphVersion | undefined = useMemo(
    () => dto.versions.find((v) => v.id === selectedVersionId),
    [dto.versions, selectedVersionId]
  );

  useEffect(() => {
    if (!selectedVersion) {
      setEditName('');
      setEditDescription('');
      return;
    }
    setEditName(selectedVersion.name ?? '');
    setEditDescription(selectedVersion.description ?? '');
  }, [selectedVersion]);

  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const v of dto.versions) {
      if (v.author?.trim()) set.add(v.author.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [dto.versions]);

  const versionsNewestFirst = useMemo(
    () => [...dto.versions].sort((a, b) => b.number - a.number),
    [dto.versions]
  );

  const built = useMemo(
    () => buildVersionGraph(dto, filters, DEFAULT_LAYOUT, MAX_VISIBLE_OBJECT_NODES),
    [dto, filters]
  );
  // Edge styling is separated from graph building so toggling a filter does not
  // re-run layout for every node.
  const styledEdges = useMemo(() => styleEdges(built.edges), [built.edges]);

  /**
   * React Flow owns node measurement, and it only hands those measurements back
   * through `onNodesChange`. Without one, every rebuild of `built.nodes` handed
   * it fresh objects with no `measured`, which resets each node's handle bounds
   * — and an edge whose endpoints have no handle bounds renders as nothing. The
   * graph lost every edge, version spine included, on the first filter change.
   *
   * So the nodes live in state that React Flow can write back to, re-seeded
   * from the built graph and carrying the previous measurements across so the
   * edges do not blink out while it measures again.
   */
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<LokeeNode>(built.nodes);
  useEffect(() => {
    setFlowNodes((previous) => carryMeasurements(built.nodes, previous));
  }, [built.nodes, setFlowNodes]);

  /**
   * What the graph should light up. An inspected object wins over a selected
   * version: opening the inspector is the more specific act, and the version
   * row is still visible underneath it.
   */
  const selection: GraphSelection = selectedObject
    ? { kind: 'object', versionId: selectedObject.versionId, objectKey: selectedObject.objectKey }
    : selectedVersionId
      ? { kind: 'version', versionId: selectedVersionId }
      : null;

  const highlighted = useMemo(
    () => applyGraphHighlight(flowNodes, styledEdges, selection),
    // `selection` is rebuilt each render; its three fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flowNodes, styledEdges, selection?.kind, (selection as { versionId?: string })?.versionId, (selection as { objectKey?: string })?.objectKey]
  );
  const edges = highlighted.edges;
  const tablesOnly =
    filters.objectTypes.size === 1 && filters.objectTypes.has('table');
  const wideGraph = built.columns.length > FIT_OBJECT_COLUMNS;

  const toggleType = useCallback((type: LokeeObjectType) => {
    setFilters((f) => {
      const next = new Set(f.objectTypes);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { ...f, objectTypes: next };
    });
  }, []);

  const toggleStatus = useCallback((status: GraphChangeStatus) => {
    setFilters((f) => {
      const next = new Set(f.statuses);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return { ...f, statuses: next };
    });
  }, []);

  const toggleVersion = useCallback((versionId: string) => {
    setFilters((f) => {
      const next = new Set(f.versionIds);
      if (next.has(versionId)) next.delete(versionId);
      else next.add(versionId);
      return { ...f, versionIds: next };
    });
  }, []);

  const toggleAuthor = useCallback((author: string) => {
    setFilters((f) => {
      const next = new Set(f.authors);
      if (next.has(author)) next.delete(author);
      else next.add(author);
      return { ...f, authors: next };
    });
  }, []);

  // Which version the compare modal is showing; null when it is closed.
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null);

  const onNodeClick = useCallback(
    // Typed as the node union, so `node.type` narrows `node.data` — previously
    // the check and the cast were independent, and a fourth node type would
    // have been silently mis-cast to SchemaObjectNodeData.
    (_: React.MouseEvent, node: LokeeNode) => {
      if (node.type === 'versionNode') {
        // Select it (the meta editor reads this) *and* open the compare, which
        // is the question a version node actually raises: what changed here?
        setSelectedVersionId(node.data.versionId);
        setCompareVersionId(node.data.versionId);
        return;
      }
      setSelectedVersionId(null);
      onSelectObject?.(node.data);
    },
    [onSelectObject]
  );

  /** Empty canvas clears the highlight — and closes the inspector with it. */
  const onPaneClick = useCallback(() => {
    setSelectedVersionId(null);
    onClearSelection?.();
  }, [onClearSelection]);

  const saveVersionMeta = useCallback(async () => {
    if (!selectedVersionId || !onSaveVersionMeta || savingMeta) return;
    setSavingMeta(true);
    try {
      await onSaveVersionMeta(selectedVersionId, {
        name: editName,
        description: editDescription,
      });
    } finally {
      setSavingMeta(false);
    }
  }, [selectedVersionId, onSaveVersionMeta, savingMeta, editName, editDescription]);

  // --- Sidebar layout preference -------------------------------------------
  // Order and width are the user's, not the app's: read once on mount, written
  // back on every change so the next visit opens the way they left it.
  const [sidebarOrder, setSidebarOrder] = useState(loadHistorySidebarOrder);
  const [sidebarWidth, setSidebarWidth] = useState(loadHistorySidebarWidth);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  useEffect(() => {
    saveHistorySidebarOrder(sidebarOrder);
  }, [sidebarOrder]);

  useEffect(() => {
    saveHistorySidebarWidth(sidebarWidth);
  }, [sidebarWidth]);

  /**
   * Width drag. The listeners go on `window`, not the handle: the pointer
   * routinely outruns a 6px strip, and a handle-bound mousemove drops the drag
   * the moment it does.
   */
  const startWidthDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const onMove = (ev: MouseEvent) =>
        setSidebarWidth(clampHistorySidebarWidth(startWidth + (ev.clientX - startX)));
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sidebarWidth]
  );

  const sidebarDragProps = useCallback(
    (index: number) => ({
      isDragging: dragFrom === index,
      isDragOver: dragOver === index && dragFrom !== index,
      onDragStart: (e: React.DragEvent) => {
        setDragFrom(index);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOver(index);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragFrom !== null && dragFrom !== index) {
          setSidebarOrder((prev) => moveHistorySidebarSection(prev, dragFrom, index));
        }
        setDragFrom(null);
        setDragOver(null);
      },
      onDragEnd: () => {
        setDragFrom(null);
        setDragOver(null);
      },
    }),
    [dragFrom, dragOver]
  );

  const renderSidebarSection = (id: HistorySidebarSectionId, index: number): React.ReactNode => {
    const drag = sidebarDragProps(index);
    switch (id) {
      case 'objectType':
        return (
    <SidebarSection id="objectType" title="Object type" {...drag}>
                <div className="flex flex-col gap-1">
                  {offeredTypes.map((t) => (
                    <label
                      key={t}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-slate-300 hover:bg-slate-800/60"
                      title={`Show ${OBJECT_STYLES[t].label} objects on the graph`}
                    >
                      <input
                        type="checkbox"
                        data-testid={`lokee-rf-type-${t}`}
                        // A non-empty set is an allow-list (defaults: tables, views,
                        // functions, procedures). Empty still means "every type".
                        checked={filters.objectTypes.size === 0 || filters.objectTypes.has(t)}
                        onChange={() => toggleType(t)}
                      />
                      {/* The legend colour, now attached to the control that uses it. */}
                      <span className={`h-2 w-2 shrink-0 rounded-full ${objectStyle(t).dot}`} aria-hidden />
                      {OBJECT_STYLES[t].label}
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-center gap-2 text-slate-300">
                    <input
                      type="checkbox"
                      data-testid="lokee-rf-show-deleted"
                      checked={filters.showDeleted}
                      onChange={() => setFilters((f) => ({ ...f, showDeleted: !f.showDeleted }))}
                    />
                    Show Deleted
                  </label>
                  <label className="mt-1 flex cursor-pointer items-center gap-2 font-semibold text-amber-300">
                    <input
                      type="checkbox"
                      data-testid="lokee-rf-changes-only"
                      checked={filters.changesOnly}
                      onChange={() => setFilters((f) => ({ ...f, changesOnly: !f.changesOnly }))}
                    />
                    Changes only
                  </label>
                </div>
              </SidebarSection>
        );
      case 'objectStatus':
        return (
    <SidebarSection id="objectStatus" title="Object status" {...drag}>
                <div className="flex flex-col gap-1">
                  {STATUSES.map((s) => {
                    const on = filters.statuses.size === 0 || filters.statuses.has(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        data-testid={`lokee-rf-status-${s}`}
                        aria-pressed={filters.statuses.has(s)}
                        onClick={() => toggleStatus(s)}
                        title={`Show only ${statusStyle(s).label} objects`}
                        className={`flex items-center gap-2 rounded px-1 py-0.5 text-left transition hover:bg-slate-800/60 ${
                          on ? 'text-slate-200' : 'text-slate-500'
                        }`}
                      >
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${statusStyle(s).dot} ${
                            on ? '' : 'opacity-30'
                          }`}
                          aria-hidden
                        />
                        <span className="truncate">{statusStyle(s).label}</span>
                        {filters.statuses.has(s) && (
                          <span className="ml-auto text-[9px] font-bold uppercase text-cyan-300">only</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </SidebarSection>
        );
      case 'version':
        return (
    <SidebarSection id="version" title="Version" {...drag}>
                <div
              data-testid="lokee-rf-version-list"
              style={SCROLL_LIST}
              className="flex max-h-52 flex-col gap-1 overflow-y-auto pr-1"
            >
                  {versionsNewestFirst.map((v) => (
                    <label key={v.id} className="flex cursor-pointer items-start gap-2 text-slate-300">
                      <input
                        type="checkbox"
                        data-testid={`lokee-rf-version-${v.id}`}
                        className="mt-0.5"
                        checked={filters.versionIds.size === 0 || filters.versionIds.has(v.id)}
                        onChange={() => toggleVersion(v.id)}
                      />
                      <span className="min-w-0 leading-tight">
                        <span className="block truncate font-medium">{versionDisplayName(v)}</span>
                        <span className="text-[10px] text-slate-500">v{v.number}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </SidebarSection>
        );
      case 'date':
        return (
    <SidebarSection id="date" title="Date" {...drag}>
                <div className="flex flex-col gap-1.5">
                  <label className="flex flex-col gap-0.5 text-slate-400">
                    From
                    <input
                      type="date"
                      data-testid="lokee-rf-date-from"
                      value={filters.dateFrom}
                      onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
                      className="rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px] text-slate-200"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 text-slate-400">
                    To
                    <input
                      type="date"
                      data-testid="lokee-rf-date-to"
                      value={filters.dateTo}
                      onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
                      className="rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px] text-slate-200"
                    />
                  </label>
                </div>
              </SidebarSection>
        );
      case 'user':
        return (
    <SidebarSection id="user" title="User" {...drag}>
                {authors.length === 0 ? (
                  <p className="text-[10px] text-slate-500">No authors on these versions.</p>
                ) : (
                  <div style={SCROLL_LIST} className="flex max-h-36 flex-col gap-1 overflow-y-auto pr-1">
                    {authors.map((author) => (
                      <label key={author} className="flex cursor-pointer items-center gap-2 text-slate-300">
                        <input
                          type="checkbox"
                          data-testid={`lokee-rf-author-${author}`}
                          checked={filters.authors.size === 0 || filters.authors.has(author)}
                          onChange={() => toggleAuthor(author)}
                        />
                        <span className="truncate" title={author}>
                          {author}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </SidebarSection>
        );
      default:
        return null;
    }
  };

  const offeredTypes = useMemo(
    () => offeredObjectTypes(dto.objects, filters.objectTypes),
    [dto.objects, filters.objectTypes]
  );

  const changed = dto.objects.filter((o) => o.status !== 'unchanged').length;
  // "reused" is how the store thinks — one object pointed at by many versions.
  // A reader of the history is asking what moved and what did not.
  const unchanged = dto.objects.length - changed;

  return (
    <div data-testid="lokee-weave-page" className="flex h-full min-h-0 flex-col gap-2 overflow-hidden px-6 pt-2">
      {/* One compact line. The title, the subtitle and a three-line totals card
          cost ~90px of vertical space above a graph that is the whole point of
          the pane, and the database is already named in the picker above. */}
      <header
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400"
        data-testid="lokee-summary"
      >
        <span className="font-semibold text-slate-300">
          Schema history
        </span>
        <span className="text-slate-600">·</span>
        <span>
          <span className="font-bold text-slate-100">{dto.totalVersions}</span> versions
        </span>
        <span>
          <span className="font-bold text-slate-100">{dto.totalObjects}</span> objects
        </span>
        <span className="text-slate-500">
          {changed} changed · {unchanged} unchanged
        </span>
        {subtitle && <span className="truncate text-slate-600">{subtitle}</span>}
      </header>

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <aside
          data-testid="lokee-sidebar"
          style={{ width: sidebarWidth }}
          className="flex shrink-0 flex-col gap-2 overflow-y-auto text-[11px]"
        >
          {sidebarOrder.map((id, index) => (
            <React.Fragment key={id}>{renderSidebarSection(id, index)}</React.Fragment>
          ))}

          {selectedVersion && (
            <SidebarSection id="editVersion" title="Edit version">
              <div className="flex flex-col gap-1.5" data-testid="lokee-version-editor">
                <div className="text-[10px] text-slate-500">v{selectedVersion.number}</div>
                <label className="flex flex-col gap-0.5 text-slate-400">
                  Name
                  <input
                    type="text"
                    data-testid="lokee-version-name"
                    maxLength={120}
                    value={editName}
                    placeholder={`Version ${selectedVersion.number}`}
                    onChange={(e) => setEditName(e.target.value)}
                    className="rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px] text-slate-200"
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-slate-400">
                  Description
                  <textarea
                    data-testid="lokee-version-description"
                    maxLength={4000}
                    rows={3}
                    value={editDescription}
                    placeholder="Optional notes for this version"
                    onChange={(e) => setEditDescription(e.target.value)}
                    className="resize-y rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[11px] text-slate-200"
                  />
                </label>
                <div className="flex gap-1">
                  <button
                    type="button"
                    data-testid="lokee-version-save"
                    disabled={!onSaveVersionMeta || savingMeta}
                    onClick={() => void saveVersionMeta()}
                    className="rounded border border-cyan-500/40 bg-cyan-950/40 px-2 py-1 text-[11px] font-semibold text-cyan-100 disabled:opacity-40"
                  >
                    {savingMeta ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    data-testid="lokee-version-close"
                    onClick={() => setSelectedVersionId(null)}
                    className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300"
                  >
                    Close
                  </button>
                </div>
              </div>
            </SidebarSection>
          )}

          <SidebarSection id="layout" title="Layout">
            <button
              type="button"
              data-testid="lokee-rf-lock"
              aria-pressed={locked}
              onClick={() => setLocked((v) => !v)}
              className="flex items-center gap-1.5 rounded border border-slate-700 px-1.5 py-0.5 text-slate-300 hover:text-slate-100"
            >
              {locked ? (
                <Lock className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
              ) : (
                <Unlock className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
              )}
              {locked ? 'Locked' : 'Unlocked'}
            </button>
            <p className="mt-1 text-[10px] leading-tight text-slate-500">
              Dragging is a view preference only — it never changes history.
            </p>
            <button
              type="button"
              data-testid="lokee-rf-clear-filters"
              onClick={() => setFilters(freshFilters())}
              className="mt-2 rounded border border-slate-700 px-1.5 py-0.5 text-slate-400 hover:text-slate-200"
            >
              Clear filters
            </button>
          </SidebarSection>
        </aside>

        {/* Width handle. `separator` with an orientation and value range so it
            is operable and announced, not a bare div that only a mouse can
            find. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize filter sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_HISTORY_SIDEBAR_WIDTH}
          aria-valuemax={MAX_HISTORY_SIDEBAR_WIDTH}
          tabIndex={0}
          data-testid="lokee-sidebar-resize"
          title="Drag to resize (double-click to reset)"
          onMouseDown={startWidthDrag}
          onDoubleClick={() => setSidebarWidth(DEFAULT_HISTORY_SIDEBAR_WIDTH)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setSidebarWidth((w) => clampHistorySidebarWidth(w - 16));
            else if (e.key === 'ArrowRight') setSidebarWidth((w) => clampHistorySidebarWidth(w + 16));
            else return;
            e.preventDefault();
          }}
          className="-mx-1 w-1.5 shrink-0 cursor-col-resize rounded bg-transparent transition-colors hover:bg-cyan-500/40 focus:bg-cyan-500/40 focus:outline-none"
        />

        <div className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-slate-700">
          {built.hiddenByCap > 0 && (
            <div
              data-testid="lokee-rf-capped"
              className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-200"
            >
              <AlertTriangle className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
              Too many objects to render clearly — showing changed objects first (
              {built.hiddenByCap} hidden).
            </div>
          )}
          {tablesOnly && distinctObjectKeys(dto) >= AUTO_TABLES_ONLY_AT && (
            <div
              data-testid="lokee-rf-tables-only-hint"
              className={`absolute left-2 z-10 max-w-sm rounded border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[10px] text-sky-100 ${
                built.hiddenByCap > 0 ? 'top-10' : 'top-2'
              }`}
            >
              Showing <span className="font-semibold">tables</span> only so the graph stays
              readable ({distinctObjectKeys(dto)} objects total). Enable Views / Functions /
              Procedures in the sidebar, then pan right for more.
            </div>
          )}
          {!tablesOnly && wideGraph && (
            <div
              data-testid="lokee-rf-wide-hint"
              className={`absolute left-2 z-10 max-w-sm rounded border border-slate-600 bg-slate-900/90 px-2 py-1 text-[10px] text-slate-300 ${
                built.hiddenByCap > 0 ? 'top-10' : 'top-2'
              }`}
            >
              Large graph — zoomed to the left. Scroll / pan to explore, or filter object types.
            </div>
          )}
          {dto.versions.length === 0 ? (
            <div
              data-testid="lokee-rf-empty"
              className="flex h-full items-center justify-center px-6 text-center text-xs text-slate-500"
            >
              No schema changes recorded yet.
            </div>
          ) : (
            <ReactFlowProvider>
              <ReactFlow
                nodes={highlighted.nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                nodeTypes={LOKEE_NODE_TYPES}
                nodesDraggable={!locked}
                nodesConnectable={false}
                elementsSelectable
                onNodeClick={onNodeClick}
                onPaneClick={onPaneClick}
                minZoom={0.35}
                maxZoom={1.75}
                defaultViewport={{ x: 24, y: 24, zoom: 1 }}
                style={{ width: '100%', height: '100%' }}
                /**
                 * React Flow is plain MIT (see node_modules/@xyflow/react/LICENSE).
                 * Its only condition is that the copyright and permission notice
                 * travel with the software, which THIRD-PARTY-NOTICES.md at the
                 * repo root does — the on-canvas badge is not a licence term.
                 * xyflow asks that you subscribe to Pro when you hide it; that is
                 * a request, and the project has chosen not to.
                 */
                proOptions={{ hideAttribution: true }}
              >
                <FitReadableView nodes={built.nodes} />
                <Background gap={20} />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  data-testid="lokee-minimap"
                  // React Flow's default minimap is opaque white, which reads as
                  // a hole in the canvas. The mask must follow the theme too: a
                  // slate-900 mask over a light canvas is a solid grey slab with
                  // a window punched in it, which is what "empty map" looked
                  // like — the nodes were under it, not missing.
                  className={isLight ? '!bg-white' : '!bg-slate-900'}
                  maskColor={isLight ? 'rgba(148,163,184,0.25)' : 'rgba(15,23,42,0.6)'}
                  // Literal colours, not `var(--color-*)`. These are painted
                  // into SVG fills where an unresolved custom property yields
                  // nothing at all rather than a fallback — the same silent
                  // blanking CLAUDE.md warns about for the theme vars.
                  nodeColor={(n) =>
                    n.type === 'versionNode'
                      ? '#a78bfa'
                      : n.type === 'deletedObjectNode'
                        ? '#fb7185'
                        : '#38bdf8'
                  }
                  nodeStrokeWidth={3}
                />
              </ReactFlow>
            </ReactFlowProvider>
          )}
        </div>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-4 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-[10px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-px w-6 bg-slate-400" aria-hidden /> Created in this version
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-px w-6 border-t border-dashed border-sky-400" aria-hidden />{' '}
          Unchanged from previous version
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-px w-6 border-t border-dashed border-amber-400"
            aria-hidden
          />{' '}
          Modified from previous version
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-px w-6 border-t border-dashed border-rose-400"
            aria-hidden
          />{' '}
          Deleted in this version
        </span>
      </footer>

      {compareVersionId && (
        <VersionCompareModal
          databaseId={dto.databaseId}
          versionId={compareVersionId}
          onClose={() => setCompareVersionId(null)}
        />
      )}
    </div>
  );
};
