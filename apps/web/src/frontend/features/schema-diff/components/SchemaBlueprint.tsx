/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The object blueprint — what changed *inside* one object — shared by every
 * comparison.
 *
 * Extracted from `ObjectDetailPanel` for the same reason `SchemaDiffTree` was
 * extracted from `SchemaTreePanel`: the panel reads the live compare, the deploy
 * selection and the search term straight out of `useSyncStore`, so version
 * history could not render it and grew a second, thinner blueprint of its own.
 * Two renderings of one idea drift — the history one showed a flat list of
 * changed children while Compare Schema showed original/target state per
 * attribute, and only one of them ever gained the primary-key, index and
 * trigger sections.
 *
 * This half takes props only. Everything the workspace layers on top —
 * per-member and per-index deploy checkboxes, expandable trigger DDL, the
 * Monaco definition editor — is an optional prop or a slot, so history gets the
 * same tables without the migrate machinery.
 */
import React from 'react';
import { ChevronDown, ChevronRight, KeyRound } from 'lucide-react';
import type { ColumnDiff, TableDiff } from '@/shared/lib/types';
import { highlightMatch } from '@/features/schema-diff/lib/highlight';
import { diffLines } from '@/shared/utils/lineDiff';
import { blockedColumns, supportsColumnSelection } from '@/shared/lib/column-selection';

/** `comfortable` is the full-width workspace; `compact` fits a modal pane. */
export type BlueprintDensity = 'comfortable' | 'compact';

type ColumnState = NonNullable<ColumnDiff['source']>;

export interface SchemaBlueprintProps {
  diff: TableDiff;
  /** Search keyword to highlight in object names. */
  query?: string;
  /** Include UNCHANGED children. Browse mode passes true — nothing is compared. */
  showUnchanged?: boolean;
  density?: BlueprintDensity;

  /** ROLE members: deploy selection. Opt-OUT (checked unless explicitly false). */
  memberSelection?: Record<string, boolean>;
  onToggleMember?: (name: string) => void;
  onSelectAllMembers?: (checked: boolean) => void;

  /** Indexes: deploy selection. Opt-IN — an index change ships only if ticked. */
  indexSelection?: Record<string, boolean>;
  onToggleIndex?: (name: string) => void;
  onSelectAllIndexes?: (checked: boolean) => void;

  /**
   * Columns: deploy selection. Opt-OUT, like role members — a fresh compare
   * migrates every changed column, and unticking is the deliberate act.
   *
   * `blockedColumns` marks the ones that cannot be dropped without producing a
   * script that fails partway; those render disabled with the reason on hover.
   */
  columnSelection?: Record<string, boolean>;
  onToggleColumn?: (name: string) => void;
  onSelectAllColumns?: (checked: boolean) => void;
  /**
   * The other tables going into the script. A foreign key sits on the child and
   * names columns on the parent, so without these a parent column looks free to
   * untick while the store quietly keeps it — a checkbox showing an exclusion
   * the script does not honour.
   */
  siblingDiffs?: readonly TableDiff[];

  /** Triggers: deploy selection. Opt-OUT; nothing else in the script needs them. */
  triggerSelection?: Record<string, boolean>;
  onToggleTriggerSelection?: (name: string) => void;
  onSelectAllTriggers?: (checked: boolean) => void;

  /** Trigger rows expand to a DDL diff when the owner supplies the formatted text. */
  expandedTriggers?: Record<string, boolean>;
  onToggleTrigger?: (name: string) => void;
  triggerDdls?: Record<string, { oldDdl?: string; newDdl?: string }>;
  ignoreCase?: boolean;

  /**
   * Rendered under the primary key, for views and routines. The workspace puts
   * a lazy-loaded Monaco editor here; callers without one pass nothing.
   */
  definitionSlot?: React.ReactNode;
}

const badge = (cls: string, text: string, title?: string): React.ReactElement => (
  <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${cls}`} title={title}>
    {text}
  </span>
);

const NO_CHANGE = badge('text-slate-500 bg-slate-900 border-slate-800', 'No Change');
const NONE = <span className="text-slate-600 italic">none</span>;

const OP_BADGE = {
  added: (text: string, title?: string) =>
    badge('text-emerald-400 bg-emerald-950/40 border-emerald-500/20', text, title),
  removed: (text: string, title?: string) =>
    badge('text-rose-400 bg-rose-950/40 border-rose-500/20', text, title),
  modified: (text: string, title?: string) =>
    badge('text-amber-400 bg-amber-950/40 border-amber-500/20', text, title),
  rename: (text: string, title?: string) =>
    badge('text-amber-300 bg-amber-950/40 border-amber-500/20', text, title),
};

/** Row tint per status, so a table of changes reads at a glance. */
function rowTint(status: string): string {
  switch (status) {
    case 'ADDED':
      return 'bg-emerald-950/10 hover:bg-emerald-950/20';
    case 'REMOVED':
      return 'bg-rose-950/10 hover:bg-rose-950/20';
    case 'MODIFIED':
      return 'bg-amber-950/10 hover:bg-amber-950/20';
    default:
      return 'hover:bg-slate-900/20';
  }
}

/** One side's column state, highlighting the attributes that differ from the other. */
export function renderColumnState(own?: ColumnState, other?: ColumnState): React.ReactElement {
  if (!own) return NONE;

  const hl = 'text-amber-300 bg-amber-500/15 rounded px-1';
  const typeChanged = !!other && own.type.toLowerCase() !== other.type.toLowerCase();
  const nullChanged = !!other && own.nullable !== other.nullable;
  const defChanged = !!other && (own.defaultValue ?? null) !== (other.defaultValue ?? null);
  const pkChanged = !!other && !!own.primaryKey !== !!other.primaryKey;
  const identityChanged = !!other && !!own.identity !== !!other.identity;
  const hasDefault = own.defaultValue !== undefined && own.defaultValue !== null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={typeChanged ? hl : ''}>{own.type}</span>

      {(!own.nullable || nullChanged) && (
        <span className={nullChanged ? hl : ''}>{own.nullable ? 'NULL' : 'NOT NULL'}</span>
      )}

      {hasDefault ? (
        <span className={defChanged ? hl : ''}>DEFAULT {own.defaultValue}</span>
      ) : defChanged ? (
        <span className={`${hl} italic`}>no default</span>
      ) : null}

      {own.primaryKey ? (
        <span
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
            pkChanged
              ? 'text-amber-300 bg-amber-500/15 border-amber-500/40'
              : 'text-amber-400 bg-amber-950/40 border-amber-500/20'
          }`}
        >
          PRIMARY KEY
        </span>
      ) : pkChanged ? (
        <span className={`${hl} italic`}>not PK</span>
      ) : null}

      {own.identity ? (
        <span
          className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
            identityChanged
              ? 'text-amber-300 bg-amber-500/15 border-amber-500/40'
              : 'text-emerald-400 bg-emerald-950/40 border-emerald-500/20'
          }`}
        >
          IDENTITY
        </span>
      ) : identityChanged ? (
        <span className={`${hl} italic`}>not identity</span>
      ) : null}
    </span>
  );
}

/** Counts over the FULL set, independent of the show-unchanged toggle. */
function stat(items: readonly { status: string }[]): {
  original: number;
  added: number;
  modified: number;
  removed: number;
} {
  return {
    original: items.filter((x) => x.status !== 'ADDED').length,
    added: items.filter((x) => x.status === 'ADDED').length,
    modified: items.filter((x) => x.status === 'MODIFIED').length,
    removed: items.filter((x) => x.status === 'REMOVED').length,
  };
}

function SectionHeading({
  dot,
  children,
  action,
}: {
  dot: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5 flex items-center gap-2">
      <span className={`w-1.5 h-1.5 ${dot} rounded-full`}></span> {children}
      {action}
    </h4>
  );
}

export function SchemaBlueprint({
  diff,
  query = '',
  showUnchanged = false,
  density = 'comfortable',
  memberSelection,
  onToggleMember,
  onSelectAllMembers,
  indexSelection,
  onToggleIndex,
  columnSelection,
  onToggleColumn,
  onSelectAllColumns,
  siblingDiffs,
  triggerSelection,
  onToggleTriggerSelection,
  onSelectAllTriggers,
  onSelectAllIndexes,
  expandedTriggers,
  onToggleTrigger,
  triggerDdls,
  ignoreCase = true,
  definitionSlot,
}: SchemaBlueprintProps): React.ReactElement {
  const compact = density === 'compact';
  const cell = compact ? 'px-2 py-1.5' : 'p-3';
  // Five columns do not fit a 400px inspector, and clipping them silently hides
  // the target side. Narrow hosts scroll the table instead.
  const shell = `bg-slate-950/60 border border-slate-800/80 rounded-lg ${
    compact ? 'overflow-x-auto' : ''
  }`;
  const head =
    'sticky top-0 z-[1] bg-slate-900 border-b border-slate-800 text-slate-400 shadow-[0_1px_0_0_rgb(30_41_59)]';

  const isRole = diff.objectType === 'ROLE';
  const keep = (status: string) => showUnchanged || status !== 'UNCHANGED';
  const colDiffs = diff.columnDiffs.filter((c) => keep(c.status));
  const indexDiffs = diff.indexDiffs.filter((i) => keep(i.status));
  // Position in the *unfiltered* list. Numbering the rendered rows instead
  // would renumber them the moment "show unchanged" is off, so column 7 would
  // read as 2 — a worse lie than showing nothing. Column order is the source
  // table's own (compare.module builds it from the source columns first).
  const positionOf = new Map(diff.columnDiffs.map((c, i) => [c.name, i + 1]));
  const indexPositionOf = new Map(diff.indexDiffs.map((i, n) => [i.name, n + 1]));
  const fkDiffs = diff.foreignKeyDiffs.filter((f) => keep(f.status));
  const trgDiffs = (diff.triggerDiffs ?? []).filter((t) => keep(t.status));

  const summary = [
    { label: 'Columns', s: stat(diff.columnDiffs) },
    { label: 'Indexes', s: stat(diff.indexDiffs) },
    { label: 'Foreign Keys', s: stat(diff.foreignKeyDiffs) },
    { label: 'Triggers', s: stat(diff.triggerDiffs ?? []) },
  ];

  // Selection is only offered when the owner wired a handler — history renders
  // the same tables read-only.
  const roleChangedMembers = isRole ? diff.columnDiffs.filter((c) => c.status !== 'UNCHANGED') : [];

  // Which columns the migration refuses to drop, and why. Computed from the
  // index opt-ins actually in play, so an index nobody ticked does not pin a
  // column the reader is free to leave out.
  const includedIndexKeys = React.useMemo(
    () =>
      new Set(
        Object.entries(indexSelection ?? {})
          .filter(([, v]) => v === true)
          .map(([k]) => k.toUpperCase())
      ),
    [indexSelection]
  );
  const blocked = React.useMemo(
    () =>
      blockedColumns(diff, {
        includedIndexes: includedIndexKeys,
        siblings: siblingDiffs,
        // Same opt-outs the script uses: an unticked trigger must not pin a
        // column the reader is free to leave out.
        triggerSelection,
      }),
    [diff, includedIndexKeys, siblingDiffs, triggerSelection]
  );
  // Only an existing table migrates column by column. A create renders columns,
  // indexes and triggers from `sourceTable` as one statement, and a view or
  // routine from its stored definition — a checkbox on either could not be
  // honoured, so it is not offered.
  const perColumn = supportsColumnSelection(diff);
  const changedColumns = isRole || !perColumn ? [] : diff.columnDiffs.filter((c) => c.status !== 'UNCHANGED');
  const allColumnsSelected =
    changedColumns.length > 0 &&
    changedColumns.every((c) => columnSelection?.[c.name] !== false);
  const changedTriggers = perColumn
    ? (diff.triggerDiffs ?? []).filter((t) => t.status !== 'UNCHANGED')
    : [];
  const allTriggersSelected =
    changedTriggers.length > 0 &&
    changedTriggers.every((t) => triggerSelection?.[t.name] !== false);
  const allMembersSelected =
    roleChangedMembers.length > 0 &&
    roleChangedMembers.every((m) => memberSelection?.[m.name] !== false);
  const indexChangedItems = diff.indexDiffs.filter((i) => i.status !== 'UNCHANGED');
  const allIndexesSelected =
    indexChangedItems.length > 0 && indexChangedItems.every((i) => indexSelection?.[i.name] === true);

  return (
    <div
      data-testid="schema-blueprint"
      className={compact ? 'space-y-4 text-[11px]' : 'space-y-6 text-xs'}
    >
      {/* Change summary — original count + added/modified/removed per category */}
      <div
        data-testid="blueprint-summary"
        className={`grid grid-cols-2 ${compact ? 'gap-2' : 'md:grid-cols-4 gap-3'}`}
      >
        {summary.map(({ label, s }) => (
          <div
            key={label}
            className={`rounded-lg border border-slate-800 bg-slate-950/40 ${compact ? 'p-2' : 'p-3'}`}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">
                {label}
              </span>
              <span
                className={`${compact ? 'text-base' : 'text-xl'} font-extrabold text-slate-100 leading-none`}
                title={`${s.original} in original`}
              >
                {s.original}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-bold">
              {s.added > 0 && <span className="text-emerald-400">+{s.added} added</span>}
              {s.modified > 0 && <span className="text-amber-400">~{s.modified} modified</span>}
              {s.removed > 0 && <span className="text-rose-400">-{s.removed} removed</span>}
              {s.added === 0 && s.modified === 0 && s.removed === 0 && (
                <span className="text-slate-600">no changes</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Routine parameters (functions & procedures) */}
      {(diff.objectType === 'FUNCTION' || diff.objectType === 'PROCEDURE') &&
        (() => {
          const routine = diff.sourceTable ?? diff.targetTable;
          const params = routine?.parameters ?? [];
          const modeCls = (m: string) =>
            m === 'RETURN' || m === 'RESULT'
              ? 'text-emerald-300 bg-emerald-950/40 border-emerald-500/25'
              : m === 'OUT' || m === 'INOUT'
                ? 'text-amber-300 bg-amber-950/40 border-amber-500/25'
                : 'text-slate-300 bg-slate-800 border-slate-700/50';
          return (
            <div className="space-y-2" data-testid="blueprint-parameters">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-cyan-500 rounded-full"></span>
                Parameters
                {diff.objectType === 'FUNCTION' && routine?.functionKind && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border text-indigo-300 bg-indigo-950/40 border-indigo-500/30 uppercase tracking-wider">
                    {routine.functionKind}-valued
                  </span>
                )}
              </h4>
              {params.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No parameters.</p>
              ) : (
                <div className={shell}>
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className={head}>
                        <th className={`${cell} font-semibold`}>Parameter</th>
                        <th className={`${cell} font-semibold`}>Type</th>
                        <th className={`${cell} font-semibold text-right`}>Mode</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-850">
                      {params.map((p, i) => (
                        <tr key={`${p.name}-${i}`} className="hover:bg-slate-900/30">
                          <td className={`${cell} font-mono text-slate-200`}>
                            {p.name || <span className="text-slate-600 italic">(unnamed)</span>}
                          </td>
                          <td className={`${cell} font-mono text-cyan-300/90`}>{p.type}</td>
                          <td className={`${cell} text-right`}>
                            <span
                              className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${modeCls(p.mode)}`}
                            >
                              {p.mode}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}

      {/* Sequence / type attributes */}
      {(diff.objectType === 'SEQUENCE' || diff.objectType === 'TYPE') &&
        (() => {
          const isSeq = diff.objectType === 'SEQUENCE';
          const src = isSeq ? diff.sourceTable?.sequence : diff.sourceTable?.userType;
          const tgt = isSeq ? diff.targetTable?.sequence : diff.targetTable?.userType;
          const rows: { label: string; key: string }[] = isSeq
            ? [
                { label: 'Data Type', key: 'dataType' },
                { label: 'Start', key: 'start' },
                { label: 'Increment', key: 'increment' },
                { label: 'Min Value', key: 'minValue' },
                { label: 'Max Value', key: 'maxValue' },
                { label: 'Cycle', key: 'cycle' },
                { label: 'Cache', key: 'cache' },
              ]
            : [
                { label: 'Source Type', key: 'sourceType' },
                { label: 'Meta Type', key: 'metaType' },
              ];
          const read = (o: unknown, key: string): unknown =>
            o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
          const fmt = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));
          const attrsOf = (o: unknown): { name: string; type: string }[] => {
            const list = read(o, 'attributes');
            return Array.isArray(list) ? (list as { name: string; type: string }[]) : [];
          };

          return (
            <div data-testid="blueprint-attributes">
              <h4 className="text-sm font-bold text-slate-200 uppercase tracking-wider mb-2.5 flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${isSeq ? 'bg-teal-400' : 'bg-sky-400'}`}></span>
                {isSeq ? 'Sequence Attributes' : 'Type Definition'}
              </h4>
              <div className={shell}>
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-900 border-b border-slate-800 text-slate-300">
                      <th className={`${cell} text-[11px] font-bold uppercase tracking-wider`}>
                        Attribute
                      </th>
                      <th className={`${cell} text-[11px] font-bold uppercase tracking-wider`}>
                        Original Server
                      </th>
                      <th
                        className={`${cell} text-[11px] font-bold uppercase tracking-wider text-center`}
                      >
                        Compare
                      </th>
                      <th className={`${cell} text-[11px] font-bold uppercase tracking-wider`}>
                        Target
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-850">
                    {rows.map((r) => {
                      const sv = fmt(read(src, r.key));
                      const tv = fmt(read(tgt, r.key));
                      const changed = sv !== tv;
                      return (
                        <tr key={r.key} className={changed ? 'bg-amber-950/10' : 'hover:bg-slate-900/20'}>
                          <td className={`${cell} text-slate-100 font-bold`}>{r.label}</td>
                          <td
                            className={`${cell} font-mono font-semibold ${changed ? 'text-amber-300' : 'text-slate-200'}`}
                          >
                            {sv}
                          </td>
                          <td className={`${cell} text-center text-slate-600`}>
                            <ChevronRight className="w-4 h-4 mx-auto" />
                          </td>
                          <td
                            className={`${cell} font-mono font-semibold ${changed ? 'text-amber-300' : 'text-slate-200'}`}
                          >
                            {tv}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Structured type member attributes */}
              {!isSeq &&
                (attrsOf(src).length > 0 || attrsOf(tgt).length > 0) &&
                (() => {
                  const sAttrs = attrsOf(src);
                  const tAttrs = attrsOf(tgt);
                  const sMap = new Map(sAttrs.map((a) => [a.name.toUpperCase(), a]));
                  const tMap = new Map(tAttrs.map((a) => [a.name.toUpperCase(), a]));
                  const names = Array.from(
                    new Set([...sAttrs.map((a) => a.name), ...tAttrs.map((a) => a.name)])
                  );
                  return (
                    <div className="mt-3">
                      <h5 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                        Attributes
                      </h5>
                      <div className={shell}>
                        <table className="w-full text-left border-collapse text-sm">
                          <thead>
                            <tr className="bg-slate-900 border-b border-slate-800 text-slate-300">
                              <th className={`${cell} text-[11px] font-bold uppercase tracking-wider`}>
                                Attribute
                              </th>
                              <th className={`${cell} text-[11px] font-bold uppercase tracking-wider`}>
                                Original Type
                              </th>
                              <th
                                className={`${cell} text-[11px] font-bold uppercase tracking-wider text-center`}
                              >
                                Compare
                              </th>
                              <th className={`${cell} text-[11px] font-bold uppercase tracking-wider`}>
                                Target Type
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-850">
                            {names.map((n) => {
                              const sa = sMap.get(n.toUpperCase());
                              const ta = tMap.get(n.toUpperCase());
                              const changed = (sa?.type ?? '') !== (ta?.type ?? '');
                              return (
                                <tr
                                  key={n}
                                  className={changed ? 'bg-amber-950/10' : 'hover:bg-slate-900/20'}
                                >
                                  <td className={`${cell} text-slate-100 font-bold font-mono`}>{n}</td>
                                  <td
                                    className={`${cell} font-mono font-semibold ${changed ? 'text-amber-300' : 'text-slate-200'}`}
                                  >
                                    {sa?.type ?? (
                                      <span className="text-slate-600 italic font-normal">none</span>
                                    )}
                                  </td>
                                  <td className={`${cell} text-center text-slate-600`}>
                                    <ChevronRight className="w-4 h-4 mx-auto" />
                                  </td>
                                  <td
                                    className={`${cell} font-mono font-semibold ${changed ? 'text-amber-300' : 'text-slate-200'}`}
                                  >
                                    {ta?.type ?? (
                                      <span className="text-slate-600 italic font-normal">none</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
            </div>
          );
        })()}

      {/* Columns (or role members) */}
      {colDiffs.length > 0 && (
        <div data-testid="blueprint-columns">
          <SectionHeading
            dot="bg-cyan-500"
            action={
              isRole && roleChangedMembers.length > 0 && onSelectAllMembers ? (
                <label
                  className="ml-auto flex items-center gap-1.5 normal-case text-[10px] font-semibold text-slate-300 cursor-pointer"
                  title="Include/exclude all changed members in the deploy script"
                >
                  <input data-testid="blueprint-all-members-selected"
                    type="checkbox"
                    checked={allMembersSelected}
                    onChange={(e) => onSelectAllMembers(e.target.checked)}
                    className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
                  />
                  Deploy all members
                </label>
              ) : !isRole && !perColumn && onToggleColumn ? (
                <span
                  data-testid="blueprint-columns-whole-object"
                  className="ml-auto normal-case text-[10px] font-normal text-slate-500"
                  title={
                    diff.status === 'ADDED'
                      ? 'A new object is created by one statement built from the source, so there is no per-column step to leave out.'
                      : diff.status === 'REMOVED'
                        ? 'A dropped object is removed by one DROP statement that names no columns, so there is no per-column step to leave out.'
                        : 'This object is replaced from its stored definition, so there is no per-column step to leave out.'
                  }
                >
                  {diff.status === 'ADDED'
                    ? 'Created whole'
                    : diff.status === 'REMOVED'
                      ? 'Dropped whole'
                      : 'Replaced whole'}
                </span>
              ) : !isRole && changedColumns.length > 0 && onSelectAllColumns ? (
                <label
                  data-testid="blueprint-columns-all"
                  className="ml-auto flex items-center gap-1.5 normal-case text-[10px] font-semibold text-slate-300 cursor-pointer"
                  title="Include/exclude every changed column in the deploy script"
                >
                  <input data-testid="blueprint-all-columns-selected"
                    type="checkbox"
                    checked={allColumnsSelected}
                    onChange={(e) => onSelectAllColumns(e.target.checked)}
                    className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
                  />
                  Migrate all columns
                </label>
              ) : undefined
            }
          >
            {isRole ? 'Members' : 'Column Blueprint / Attributes'}
          </SectionHeading>
          <div className={shell}>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className={head}>
                  {!isRole && (
                    <th className={`${cell} font-semibold text-right w-10`} title="Column position">
                      #
                    </th>
                  )}
                  <th className={`${cell} font-semibold`}>{isRole ? 'Member' : 'Column Name'}</th>
                  <th className={`${cell} font-semibold`}>Original State</th>
                  <th className={`${cell} font-semibold text-center`}>Compare</th>
                  <th className={`${cell} font-semibold`}>Target State</th>
                  <th className={`${cell} font-semibold text-right`}>Operation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                {colDiffs.map((col) => {
                  const opBadge =
                    col.status === 'ADDED'
                      ? OP_BADGE.added('ADD COLUMN')
                      : col.status === 'REMOVED'
                        ? OP_BADGE.removed('DROP COLUMN')
                        : col.status === 'MODIFIED'
                          ? OP_BADGE.modified('ALTER TYPE')
                          : NO_CHANGE;
                  const isPk = col.source?.primaryKey || col.target?.primaryKey;

                  return (
                    <tr key={col.name} className={`${rowTint(col.status)} transition-colors`}>
                      {!isRole && (
                        // Ordinal position, which is what "column id" means in
                        // the catalogs that expose one (Oracle COLUMN_ID, SQL
                        // Server column_id). Roles have members, not columns.
                        <td className={`${cell} text-right font-mono text-slate-500 tabular-nums`}>
                          {positionOf.get(col.name) ?? '—'}
                        </td>
                      )}
                      <td className={`${cell} font-semibold text-slate-200 font-mono`}>
                        <span className="flex items-center gap-1.5">
                          {isRole && col.status !== 'UNCHANGED' && onToggleMember && (
                            <input data-testid={`blueprint-include-member-in-${col.name}`}
                              type="checkbox"
                              checked={memberSelection?.[col.name] !== false}
                              onChange={() => onToggleMember(col.name)}
                              title="Include this member in the deploy script"
                              className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer shrink-0"
                            />
                          )}
                          {!isRole &&
                            perColumn &&
                            col.status !== 'UNCHANGED' &&
                            onToggleColumn &&
                            (() => {
                              // A blocked column stays ticked and disabled: the
                              // script cannot leave it out, and a box that
                              // unticks without changing the SQL would be a lie.
                              const block = blocked.get(col.name.toUpperCase());
                              return (
                                <input
                                  type="checkbox"
                                  data-testid={`blueprint-column-check-${col.name}`}
                                  checked={block ? true : columnSelection?.[col.name] !== false}
                                  disabled={!!block}
                                  onChange={() => onToggleColumn(col.name)}
                                  title={block ? block.reason : 'Migrate this column'}
                                  className={`w-3.5 h-3.5 accent-cyan-500 shrink-0 ${
                                    block ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                                  }`}
                                />
                              );
                            })()}
                          {highlightMatch(col.name, query)}
                          {isPk && (
                            <KeyRound className="w-3.5 h-3.5 text-amber-400" aria-label="Primary key" />
                          )}
                        </span>
                      </td>
                      <td className={`${cell} text-slate-400 font-mono`}>
                        {renderColumnState(col.source, col.target)}
                      </td>
                      <td className={`${cell} text-center text-slate-600`}>
                        <ChevronRight className="w-4 h-4 mx-auto text-slate-600" />
                      </td>
                      <td className={`${cell} text-slate-400 font-mono`}>
                        {renderColumnState(col.target, col.source)}
                      </td>
                      <td className={`${cell} text-right`}>{opBadge}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Primary key */}
      {diff.objectType === 'TABLE' &&
        (() => {
          const srcPk = diff.sourceTable?.primaryKey;
          const tgtPk = diff.targetTable?.primaryKey;
          const pkChanged =
            JSON.stringify(srcPk?.columns ?? []) !== JSON.stringify(tgtPk?.columns ?? []);

          let opBadge = NO_CHANGE;
          let rowBg = 'hover:bg-slate-900/10';
          if (srcPk && !tgtPk) {
            opBadge = OP_BADGE.added('ADD PRIMARY KEY');
            rowBg = 'bg-emerald-950/10';
          } else if (!srcPk && tgtPk) {
            opBadge = OP_BADGE.removed('DROP PRIMARY KEY');
            rowBg = 'bg-rose-950/10';
          } else if (srcPk && tgtPk && pkChanged) {
            opBadge = OP_BADGE.modified('RECREATE');
            rowBg = 'bg-amber-950/10';
          }

          return (
            <div data-testid="blueprint-primary-key">
              <SectionHeading dot="bg-amber-500">Primary Key</SectionHeading>
              <div className={shell}>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className={head}>
                      <th className={`${cell} font-semibold`}>Constraint Name</th>
                      <th className={`${cell} font-semibold`}>Original Columns</th>
                      <th className={`${cell} font-semibold text-center`}>Compare</th>
                      <th className={`${cell} font-semibold`}>Target Columns</th>
                      <th className={`${cell} font-semibold text-right`}>Operation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!srcPk && !tgtPk ? (
                      <tr>
                        <td colSpan={5} className={`${cell} text-slate-600 italic text-center`}>
                          No primary key defined on this table
                        </td>
                      </tr>
                    ) : (
                      <tr className={`${rowBg} transition-colors`}>
                        <td className={`${cell} text-slate-200 font-semibold font-mono`}>
                          <span className="flex items-center gap-1.5">
                            <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                            {srcPk?.name ?? tgtPk?.name ?? '—'}
                          </span>
                        </td>
                        <td className={`${cell} text-slate-400 font-mono`}>
                          {srcPk ? srcPk.columns.join(', ') : NONE}
                        </td>
                        <td className={`${cell} text-center text-slate-600`}>
                          <ChevronRight className="w-4 h-4 mx-auto text-slate-600" />
                        </td>
                        <td className={`${cell} text-slate-400 font-mono`}>
                          {tgtPk ? tgtPk.columns.join(', ') : NONE}
                        </td>
                        <td className={`${cell} text-right`}>{opBadge}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}

      {definitionSlot}

      {/* Indexes */}
      {indexDiffs.length > 0 && (
        <div data-testid="blueprint-indexes">
          <SectionHeading
            dot="bg-indigo-500"
            action={
              indexChangedItems.length > 0 && onSelectAllIndexes ? (
                <label
                  className="ml-auto flex items-center gap-1.5 normal-case text-[10px] font-semibold text-slate-300 cursor-pointer"
                  title="Include/exclude all changed indexes in the deploy script"
                >
                  <input data-testid="blueprint-all-indexes-selected"
                    type="checkbox"
                    checked={allIndexesSelected}
                    onChange={(e) => onSelectAllIndexes(e.target.checked)}
                    className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
                  />
                  Deploy all indexes
                </label>
              ) : undefined
            }
          >
            Table Indexes
          </SectionHeading>
          {onToggleIndex && indexChangedItems.some((i) => i.nameOnly) && (
            <p className="text-[11px] text-slate-500 mb-2">
              Same columns under a different name — optional; check an index to include DROP/CREATE
              in the migration.
            </p>
          )}
          <div className={shell}>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className={head}>
                  <th className={`${cell} font-semibold text-right w-10`} title="Index position">
                    #
                  </th>
                  <th className={`${cell} font-semibold`}>Index Name</th>
                  <th className={`${cell} font-semibold`}>Columns</th>
                  <th className={`${cell} font-semibold`}>Constraint</th>
                  <th className={`${cell} font-semibold text-right`}>Operation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                {indexDiffs.map((idx) => {
                  const info = idx.source || idx.target;
                  const opBadge =
                    idx.status === 'ADDED'
                      ? idx.nameOnly
                        ? OP_BADGE.rename(
                            'CREATE (rename)',
                            'Same columns as a target index under a different name'
                          )
                        : OP_BADGE.added('CREATE INDEX')
                      : idx.status === 'REMOVED'
                        ? idx.nameOnly
                          ? OP_BADGE.rename(
                              'DROP (rename)',
                              'Same columns as a source index under a different name'
                            )
                          : OP_BADGE.removed('DROP INDEX')
                        : NO_CHANGE;

                  return (
                    <tr key={idx.name} className="hover:bg-slate-900/10">
                      <td className={`${cell} text-right font-mono text-slate-500 tabular-nums`}>
                        {indexPositionOf.get(idx.name) ?? '—'}
                      </td>
                      <td className={`${cell} text-slate-200 font-semibold font-mono`}>
                        <span className="flex items-center gap-1.5">
                          {idx.status !== 'UNCHANGED' && onToggleIndex && (
                            <input data-testid={`blueprint-toggle-index-${idx.name}`}
                              type="checkbox"
                              checked={indexSelection?.[idx.name] === true}
                              onChange={() => onToggleIndex(idx.name)}
                              title={
                                idx.nameOnly
                                  ? 'Optional: include this index rename (DROP + CREATE) in the deploy script'
                                  : 'Include this index change in the deploy script'
                              }
                              className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer shrink-0"
                            />
                          )}
                          {highlightMatch(idx.name, query)}
                        </span>
                      </td>
                      <td className={`${cell} text-slate-400 font-mono`}>{info?.columns.join(', ')}</td>
                      <td className={`${cell} text-slate-400 font-mono`}>
                        {info?.unique ? 'UNIQUE' : 'NON-UNIQUE'}
                      </td>
                      <td className={`${cell} text-right`}>{opBadge}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Foreign keys */}
      {fkDiffs.length > 0 && (
        <div data-testid="blueprint-foreign-keys">
          <SectionHeading dot="bg-purple-500">Foreign Key Relations</SectionHeading>
          <div className={shell}>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className={head}>
                  <th className={`${cell} font-semibold`}>Constraint Name</th>
                  <th className={`${cell} font-semibold`}>Columns</th>
                  <th className={`${cell} font-semibold`}>References Table</th>
                  <th className={`${cell} font-semibold text-right`}>Operation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                {fkDiffs.map((fk) => {
                  const info = fk.source || fk.target;
                  const opBadge =
                    fk.status === 'ADDED'
                      ? OP_BADGE.added('ADD CONSTRAINT')
                      : fk.status === 'REMOVED'
                        ? OP_BADGE.removed('DROP CONSTRAINT')
                        : NO_CHANGE;

                  return (
                    <tr key={fk.name} className="hover:bg-slate-900/10">
                      <td className={`${cell} text-slate-200 font-semibold font-mono`}>
                        {highlightMatch(fk.name, query)}
                      </td>
                      <td className={`${cell} text-slate-400 font-mono`}>{info?.columns.join(', ')}</td>
                      <td className={`${cell} text-slate-400 font-mono`}>
                        {info?.referencedTable} ({(info?.referencedColumns ?? []).join(', ')})
                      </td>
                      <td className={`${cell} text-right`}>{opBadge}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Triggers — always visible for tables */}
      {diff.objectType === 'TABLE' && (
        <div data-testid="blueprint-triggers">
          <SectionHeading
            dot="bg-yellow-500"
            action={
              changedTriggers.length > 0 && onSelectAllTriggers ? (
                <label
                  data-testid="blueprint-triggers-all"
                  className="ml-auto flex items-center gap-1.5 normal-case text-[10px] font-semibold text-slate-300 cursor-pointer"
                  title="Include/exclude every changed trigger in the deploy script"
                >
                  <input data-testid="blueprint-all-triggers-selected"
                    type="checkbox"
                    checked={allTriggersSelected}
                    onChange={(e) => onSelectAllTriggers(e.target.checked)}
                    className="w-3.5 h-3.5 accent-yellow-500 cursor-pointer"
                  />
                  Migrate all triggers
                </label>
              ) : undefined
            }
          >
            Table Triggers
          </SectionHeading>
          <div className={shell}>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className={head}>
                  <th className={`${cell} font-semibold`}>Trigger Name</th>
                  <th className={`${cell} font-semibold`}>Original State</th>
                  <th className={`${cell} font-semibold text-center`}>Compare</th>
                  <th className={`${cell} font-semibold`}>Target State</th>
                  <th className={`${cell} font-semibold text-right`}>Operation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                {trgDiffs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className={`${cell} text-slate-600 italic text-center`}>
                      No triggers defined on this table
                    </td>
                  </tr>
                ) : (
                  trgDiffs.map((trg) => {
                    const opBadge =
                      trg.status === 'ADDED'
                        ? OP_BADGE.added('CREATE TRIGGER')
                        : trg.status === 'REMOVED'
                          ? OP_BADGE.removed('DROP TRIGGER')
                          : trg.status === 'MODIFIED'
                            ? OP_BADGE.modified('RECREATE')
                            : NO_CHANGE;

                    const stateLabel = (info?: { timing?: string; event?: string }) =>
                      info ? `${info.timing ?? ''} ${info.event ?? ''}`.trim() || 'present' : null;

                    const expandable = Boolean(onToggleTrigger);
                    const isExpanded = !!expandedTriggers?.[trg.name];
                    const { oldDdl = '', newDdl = '' } = triggerDdls?.[trg.name] ?? {};
                    // A one-sided trigger diffs against '' — drop the resulting blank line
                    const ddlLines = isExpanded
                      ? diffLines(oldDdl, newDdl, { ignoreCase }).filter(
                          (l) => !(l.text === '' && (oldDdl === '' || newDdl === ''))
                        )
                      : [];

                    return (
                      <React.Fragment key={trg.name}>
                        <tr
                          onClick={expandable ? () => onToggleTrigger?.(trg.name) : undefined}
                          title={expandable ? 'Click to show DDL diff' : undefined}
                          className={`${rowTint(trg.status)} transition-colors ${
                            expandable ? 'cursor-pointer' : ''
                          }`}
                        >
                          <td className={`${cell} text-slate-200 font-semibold font-mono`}>
                            <span className="flex items-center gap-1.5">
                              {perColumn && trg.status !== 'UNCHANGED' && onToggleTriggerSelection && (
                                <input
                                  type="checkbox"
                                  data-testid={`blueprint-trigger-check-${trg.name}`}
                                  checked={triggerSelection?.[trg.name] !== false}
                                  // The row itself toggles the DDL diff, so a
                                  // bare click here would tick the box *and*
                                  // expand the row.
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={() => onToggleTriggerSelection(trg.name)}
                                  title="Migrate this trigger"
                                  className="w-3.5 h-3.5 accent-yellow-500 cursor-pointer shrink-0"
                                />
                              )}
                              {expandable &&
                                (isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                                ))}
                              {highlightMatch(trg.name, query)}
                            </span>
                          </td>
                          <td className={`${cell} text-slate-400 font-mono`}>
                            {stateLabel(trg.source) ?? NONE}
                          </td>
                          <td className={`${cell} text-center text-slate-600`}>
                            <ChevronRight className="w-4 h-4 mx-auto text-slate-600" />
                          </td>
                          <td className={`${cell} text-slate-400 font-mono`}>
                            {stateLabel(trg.target) ?? NONE}
                          </td>
                          <td className={`${cell} text-right`}>{opBadge}</td>
                        </tr>

                        {isExpanded && (
                          <tr>
                            <td colSpan={5} className="p-0 bg-slate-950/90 border-t border-slate-800/60">
                              {trg.source?.definition || trg.target?.definition ? (
                                <div className="max-h-72 overflow-auto">
                                  <table className="w-full font-mono text-[11px] border-collapse">
                                    <tbody>
                                      {ddlLines.map((line, i) => {
                                        const textClass =
                                          line.type === 'added'
                                            ? 'text-emerald-300'
                                            : line.type === 'removed'
                                              ? 'text-rose-300'
                                              : 'text-slate-300';
                                        const lineBg =
                                          line.type === 'added'
                                            ? 'bg-emerald-500/10'
                                            : line.type === 'removed'
                                              ? 'bg-rose-500/10'
                                              : '';
                                        const marker =
                                          line.type === 'added'
                                            ? '+'
                                            : line.type === 'removed'
                                              ? '-'
                                              : ' ';
                                        return (
                                          <tr key={i} className={lineBg}>
                                            <td
                                              className={`w-5 text-center select-none ${textClass} align-top`}
                                            >
                                              {marker}
                                            </td>
                                            <td className={`px-2 py-0.5 whitespace-pre ${textClass}`}>
                                              {line.text}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                <div className="p-3 text-slate-600 italic text-center">
                                  No DDL definition available for this trigger
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
