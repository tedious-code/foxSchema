/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave graph — node renderers.
 *
 * Nodes stay deliberately thin: an icon, a name, a short hash, a status dot.
 * Everything else belongs in the inspector, because a graph that tries to show
 * a table's columns inline stops being readable at about four tables.
 */
import React, { memo } from 'react';
import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react';
import {
  Table2,
  Eye,
  Layers,
  Columns3,
  KeyRound,
  Link2,
  Zap,
  Hash,
  FunctionSquare,
  Terminal,
  Shapes,
  GitCommitVertical,
  X,
} from 'lucide-react';
import { CHANGE_KIND_LABEL, CHANGE_KIND_TITLE, type LokeeObjectType } from '@foxschema/ui-shared';
import { changeKindStyle, objectStyle, statusStyle } from '@/features/lokee-weave/lib/lokeeColors';
import {
  objectDisplayName,
  shortHash,
  versionDisplayName,
  type LokeeObjectNode,
  type LokeeVersionNode,
} from './graphTypes';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

/** Reuses the app's icon set rather than introducing a second one. */
const TYPE_ICON: Record<LokeeObjectType, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  table: Table2,
  mqt: Layers,
  view: Eye,
  column: Columns3,
  index: Hash,
  primary_key: KeyRound,
  foreign_key: Link2,
  trigger: Zap,
  sequence: Shapes,
  function: FunctionSquare,
  procedure: Terminal,
  type: Shapes,
};

export const VersionNode = memo(({ data: d, selected }: NodeProps<LokeeVersionNode>) => {
  const when = d.createdAt.replace('T', ' ').slice(0, 16);
  const label = versionDisplayName(d);
  const hasCustomName = Boolean(d.name?.trim());
  return (
    <div
      data-testid={`rf-version-${d.versionId}`}
      aria-label={`${label}, ${d.changeCount} changes`}
      className={`w-[190px] rounded-lg border bg-slate-900/80 px-3 py-2 ${
        selected ? 'border-violet-400 ring-1 ring-violet-400/60' : 'border-violet-500/40'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <GitCommitVertical className="w-4 h-4 text-violet-300" strokeWidth={SQL_ICON_STROKE} />
        <span className="truncate text-sm font-bold text-slate-100" title={label}>
          {label}
        </span>
      </div>
      {hasCustomName && (
        <div className="pl-6 text-[10px] font-medium text-violet-300/80">v{d.versionNumber}</div>
      )}
      <div className="mt-0.5 pl-6 text-[10px] text-slate-400">{when}</div>
      {d.author && <div className="pl-6 text-[10px] text-slate-500 truncate">{d.author}</div>}
      {d.description && (
        <div className="mt-1 line-clamp-2 pl-6 text-[10px] text-slate-500" title={d.description}>
          {d.description}
        </div>
      )}
      {/* A revert reads as an ordinary version otherwise — same node, same
          counts — and the one thing you want to know is which version it put
          back. */}
      {d.revertedToNumber != null && (
        <div
          data-testid={`rf-version-revert-${d.versionId}`}
          className="mt-1 pl-6 text-[10px] font-semibold text-cyan-300"
          title={`This version was produced by reverting to v${d.revertedToNumber}`}
        >
          ↩ reverted to v{d.revertedToNumber}
        </div>
      )}
      {/* A force-migrated version reads as an ordinary capture otherwise, and
          the one thing worth knowing is that its shape came from a different
          database entirely — not from anything in this history. */}
      {d.appliedFrom && (
        <div
          data-testid={`rf-version-applied-from-${d.versionId}`}
          className="mt-1 pl-6 text-[10px] font-semibold text-amber-300"
          title={
            `This schema was applied from v${d.appliedFrom.number}` +
            (d.appliedFrom.database ? ` of ${d.appliedFrom.database}` : '') +
            ' — a different database from the one this history belongs to'
          }
        >
          ⇥ from v{d.appliedFrom.number}
          {d.appliedFrom.database ? ` of ${d.appliedFrom.database}` : ''}
        </div>
      )}
      {d.changeCount > 0 && (
        <div className="mt-1 pl-6 text-[10px] font-semibold text-amber-300">
          {d.changeCount} changed
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
});
VersionNode.displayName = 'VersionNode';

export const SchemaObjectNode = memo(({ data: d, selected }: NodeProps<LokeeObjectNode>) => {
  const style = objectStyle(d.objectType);
  const status = statusStyle(d.status);
  const Icon = TYPE_ICON[d.objectType] ?? Shapes;
  // `ORDERS.NOTE` is the store's compare key, not anything in the database.
  const { label, owner } = objectDisplayName(d.name, d.objectType);
  return (
    <div
      data-testid={`rf-object-${d.versionId}-${d.objectKey}`}
      // Status must be reachable without seeing colour.
      aria-label={`${style.label} ${d.name}, ${status.label}${
        d.changeKinds?.length ? `, ${d.changeKinds.map((k) => CHANGE_KIND_TITLE[k]).join(', ')}` : ''
      }`}
      title={`${d.objectKey}\n${status.label}\nhash ${d.objectHash ?? '—'}`}
      className={`w-[150px] rounded-lg border bg-slate-900/80 px-2 py-1.5 ${status.accent} ${
        selected ? 'ring-2 ring-cyan-400/70' : ''
      }`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-1.5">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${style.dot.replace('bg-', 'text-')}`} strokeWidth={SQL_ICON_STROKE} />
        <span className="min-w-0 truncate text-[11px] font-semibold text-slate-100" title={d.name}>
          {label}
        </span>
      </div>
      {owner && (
        <div className="truncate pl-5 text-[9px] uppercase tracking-wide text-slate-500" title={owner}>
          on {owner.toLowerCase()}
        </div>
      )}
      <div className="mt-0.5 flex items-center gap-1 pl-5">
        <span className="font-mono text-[10px] text-slate-400">{shortHash(d.objectHash)}</span>
        <span
          className={`ml-auto h-2 w-2 shrink-0 rounded-full ${status.dot}`}
          aria-hidden
        />
      </div>
      {/* What kind of child moved. `modified` alone is true of a dropped column
          and of a renamed comment, and the reader cannot tell from the node. */}
      {d.changeKinds && d.changeKinds.length > 0 && (
        <div data-testid={`rf-kinds-${d.objectKey}`} className="mt-1 flex flex-wrap gap-0.5 pl-5">
          {d.changeKinds.map((kind) => (
            <span
              key={kind}
              title={CHANGE_KIND_TITLE[kind]}
              className={`rounded px-1 text-[9px] font-bold uppercase tracking-wide ${changeKindStyle(kind)}`}
            >
              {CHANGE_KIND_LABEL[kind]}
            </span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
});
SchemaObjectNode.displayName = 'SchemaObjectNode';

/** A tombstone marks where an object stopped existing; it is not carried on. */
export const DeletedObjectNode = memo(({ data: d, selected }: NodeProps<LokeeObjectNode>) => {
  const { label, owner } = objectDisplayName(d.name, d.objectType);
  return (
    <div
      data-testid={`rf-object-${d.versionId}-${d.objectKey}`}
      aria-label={`${d.name}, deleted in this version`}
      title={`${d.objectKey}\nDeleted in this version`}
      className={`w-[150px] rounded-lg border border-rose-500/60 bg-rose-500/10 px-2 py-1.5 ${
        selected ? 'ring-2 ring-cyan-400/70' : ''
      }`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-1.5">
        <X className="w-3.5 h-3.5 shrink-0 text-rose-300" strokeWidth={SQL_ICON_STROKE} />
        <span
          className="min-w-0 truncate text-[11px] font-semibold text-rose-200 line-through"
          title={d.name}
        >
          {label}
        </span>
      </div>
      <div className="mt-0.5 truncate pl-5 text-[10px] text-rose-300/80">
        {owner ? `deleted from ${owner.toLowerCase()}` : 'deleted'}
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
});
DeletedObjectNode.displayName = 'DeletedObjectNode';

/**
 * React Flow's `NodeTypes` is a `Record<string, ComponentType<NodeProps>>`
 * over the *untyped* node, so a map of payload-typed renderers cannot satisfy
 * it directly. One assertion here is the honest price: it puts the erasure at
 * the registration boundary, where React Flow genuinely loses the types,
 * instead of inside all three renderers where it silently disabled checking on
 * every field they read.
 */
export const LOKEE_NODE_TYPES = {
  versionNode: VersionNode,
  schemaObjectNode: SchemaObjectNode,
  deletedObjectNode: DeletedObjectNode,
} as unknown as NodeTypes;
