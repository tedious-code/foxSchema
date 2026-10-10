/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inspector for a Lokee graph node: columns with type/constraint subtitles,
 * a GitHub-style CREATE script diff, and a roadmap of the versions that moved
 * the object. Reverting lives in the version compare modal, which can scope it
 * to chosen objects; this panel is for reading.
 * Indexes are stored but not a first-class inspector surface.
 */
import React, { useEffect, useState } from 'react';
import { isLokeeTableLikeType, lokeeColumnChangeSubtitle, lokeeTypeLabel } from '@foxschema/ui-shared';
import { ChevronsUpDown, Loader2, X } from 'lucide-react';
import {
  inspectLokeeObject,
  type LokeeHistoryEvent,
  type LokeeInspectResult,
} from '../api/lokeeApi';
import { objectStyle } from '@/features/lokee-weave/lib/lokeeColors';
import { SchemaBlueprint } from '@/features/schema-diff/ui';
import { shortHash, type SchemaObjectNodeData } from './graphTypes';
import { GithubScriptDiff } from './GithubScriptDiff';
import { buildRoadmapRows, hiddenVersionCount } from './roadmap';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export interface LokeeObjectInspectorProps {
  databaseId: string;
  selected: SchemaObjectNodeData;
  onClose: () => void;
  onSelectVersion?: (versionId: string) => void;
}

function typeLabel(body: Record<string, unknown> | undefined): string {
  return lokeeTypeLabel(body);
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function HistoryEvent({ point }: { point: LokeeHistoryEvent }): React.ReactElement {
  const typeChange =
    point.body?.dataType != null
      ? point.previousBody?.dataType
        ? `${typeLabel(point.previousBody)} → ${typeLabel(point.body)}`
        : typeLabel(point.body)
      : null;
  const lines =
    point.lineCount != null
      ? point.previousLineCount != null && point.previousLineCount !== point.lineCount
        ? `${point.previousLineCount} → ${point.lineCount} lines`
        : `${point.lineCount} lines`
      : null;
  return (
    <li className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2 text-slate-200">
        <span className="font-semibold">
          v{point.versionNumber} · {point.operation}
        </span>
        <span className="text-[10px] text-slate-500">{formatWhen(point.createdAt)}</span>
      </div>
      {typeChange && (
        <div className="mt-0.5 text-[10px] text-slate-400">
          {point.previousBody
            ? lokeeColumnChangeSubtitle(point.body, point.previousBody)
            : typeChange}
        </div>
      )}
      {lines && <div className="text-[10px] text-slate-400">{lines}</div>}
    </li>
  );
}

export function LokeeObjectInspector({
  databaseId,
  selected,
  onClose,
  onSelectVersion,
}: LokeeObjectInspectorProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LokeeInspectResult | null>(null);
  // Roadmap view state. `showAllVersions` opens the flat stretches back up;
  // `expandedGaps` opens just one of them.
  const [showAllVersions, setShowAllVersions] = useState(false);
  const [expandedGaps, setExpandedGaps] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExpandedGaps(new Set());
    // Drop the previous object's payload: this component is not remounted when
    // the selection changes, so keeping it would render the old blueprint,
    // source, and growth under the new object's name until the fetch lands.
    setData(null);
    void inspectLokeeObject(databaseId, selected.versionId, selected.objectKey)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load object');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId, selected.versionId, selected.objectKey]);

  const focus = data?.blueprint.object ?? data?.blueprint.container;
  const source =
    focus?.sourceText ??
    (typeof focus?.body.definition === 'string' ? focus.body.definition : null);
  const script = (data?.script && data.script.length > 0 ? data.script : source) ?? '';
  const previousScript = data?.previousScript ?? '';
  const style = objectStyle(selected.objectType);
  const mutations = data?.columnMutations ?? [];
  const growthKind = data?.blueprint.container?.type ?? selected.objectType;
  const showGrowth = isLokeeTableLikeType(growthKind) && (data?.growth.length ?? 0) > 0;
  const headVersionId = data?.growth.at(-1)?.versionId ?? null;
  const roadmapRows = buildRoadmapRows(data?.growth ?? [], {
    headVersionId,
    selectedVersionId: selected.versionId,
    expandedGaps,
    showAll: showAllVersions,
  });
  const hiddenVersions = hiddenVersionCount(roadmapRows);

  return (
    <aside
      data-testid="lokee-object-inspector"
      // The panel's load state, declared rather than inferred. Without it the
      // only way to tell "still fetching" from "ready" is to string-match the
      // "Loading blueprint…" copy, which couples tests to user-facing wording.
      // `data-object-key` comes from the payload, not from `selected`, so it
      // changes only once *this* object's fetch has landed — `selected.name`
      // updates synchronously on click and proves nothing about the fetch.
      data-state={loading ? 'loading' : error ? 'error' : data ? 'ready' : 'empty'}
      data-object-key={focus?.key ?? undefined}
      className="flex w-[440px] shrink-0 flex-col overflow-hidden border-l border-slate-800 bg-slate-950/80"
    >
      <header className="flex items-start gap-2 border-b border-slate-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {style.label}
          </div>
          <div className="truncate text-sm font-semibold text-slate-100" title={selected.name}>
            {selected.name}
          </div>
          <div className="font-mono text-[10px] text-slate-500">{shortHash(selected.objectHash)}</div>
        </div>
        <button
          type="button"
          data-testid="lokee-inspector-close"
          onClick={onClose}
          className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          title="Close"
        >
          <X className="h-3.5 w-3.5" strokeWidth={SQL_ICON_STROKE} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
            Loading blueprint…
          </div>
        )}
        {error && <div className="text-xs text-rose-300">{error}</div>}
        {data && (
          <>
            {/* The blueprint is Compare Schema's own tables, fed by a stored
                diff instead of a live one — columns, primary key, indexes,
                foreign keys and triggers, with the same original/target
                columns and operation badges. `showUnchanged` because a version
                is a snapshot: the reader wants the whole object, not only the
                rows this version touched. */}
            {data.diff && (
              <div data-testid="lokee-inspector-blueprint">
                <SchemaBlueprint diff={data.diff} density="compact" showUnchanged />
              </div>
            )}

            {script && (
              <section data-testid="lokee-inspector-source">
                <GithubScriptDiff original={previousScript} modified={script} />
              </section>
            )}

            {showGrowth && (
              <section data-testid="lokee-inspector-growth">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Roadmap · v{data.growth[0]?.versionNumber}…v
                    {data.growth[data.growth.length - 1]?.versionNumber}
                    <span className="ml-1 normal-case tracking-normal text-slate-600">
                      ({data.growth.filter((g) => g.changed).length} of {data.growth.length} touched
                      this {isLokeeTableLikeType(growthKind) ? 'table' : 'object'})
                    </span>
                  </h3>
                  {/* Only worth offering while something is actually folded —
                      on a short history the button would toggle nothing. */}
                  {(hiddenVersions > 0 || showAllVersions) && (
                    <button
                      type="button"
                      data-testid="lokee-roadmap-toggle-all"
                      onClick={() => {
                        setShowAllVersions((prev) => !prev);
                        setExpandedGaps(new Set());
                      }}
                      className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-100"
                    >
                      {showAllVersions ? 'Changes only' : 'Show all versions'}
                    </button>
                  )}
                </div>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {roadmapRows.map((row) => {
                    if (row.kind === 'gap') {
                      return (
                        <li key={`gap-${row.id}`}>
                          <button
                            type="button"
                            data-testid={`lokee-roadmap-gap-${row.id}`}
                            onClick={() =>
                              setExpandedGaps((prev) => new Set(prev).add(row.id))
                            }
                            className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[10px] text-slate-500 hover:bg-slate-900 hover:text-slate-300"
                            title={`Show v${row.fromVersion}–v${row.toVersion}`}
                          >
                            <ChevronsUpDown className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
                            {row.count} versions left it unchanged · v{row.fromVersion}–v
                            {row.toVersion}
                          </button>
                        </li>
                      );
                    }
                    const g = row.point;
                    return (
                      <li
                        key={g.versionId}
                        className={`flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[11px] ${
                          row.isSelected ? 'bg-slate-800/80 text-slate-100' : 'text-slate-300'
                        }`}
                      >
                        <button
                          type="button"
                          data-testid={`lokee-inspector-version-${g.versionNumber}`}
                          onClick={() => onSelectVersion?.(g.versionId)}
                          className="min-w-0 flex-1 text-left hover:text-cyan-200"
                          title={`Show this object at v${g.versionNumber}`}
                        >
                          {/* A roadmap over a long history is mostly a flat line;
                              the marker is what makes the few versions that
                              actually touched this object findable. */}
                          <span
                            className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                              g.changed ? 'bg-amber-400' : 'bg-slate-700'
                            }`}
                            title={g.changed ? 'Changed in this version' : 'Unchanged in this version'}
                            aria-hidden
                          />
                          <span className="font-semibold text-slate-200">v{g.versionNumber}</span>
                          {g.changed && <span className="sr-only"> changed in this version</span>}
                          {row.isHead && (
                            <span className="ml-1 text-[10px] uppercase tracking-wide text-cyan-400">
                              head
                            </span>
                          )}
                          <span className="ml-2 text-slate-400">
                            {g.columns} cols
                            {g.triggers > 0 ? ` · ${g.triggers} trg` : ''}
                          </span>
                          {/* The delta is what "growth" means to a reader —
                              without it every row is an absolute count they
                              have to subtract in their head. */}
                          {row.columnDelta !== 0 && (
                            <span
                              className={`ml-1 text-[10px] font-semibold ${
                                row.columnDelta > 0 ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              {row.columnDelta > 0 ? `+${row.columnDelta}` : row.columnDelta}
                            </span>
                          )}
                        </button>
                        <span className="shrink-0 text-[10px] text-slate-600">
                          {formatWhen(g.createdAt)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section data-testid="lokee-inspector-history">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Change timeline
              </h3>
              {mutations.length > 0 ? (
                <div data-testid="lokee-inspector-column-mutations" className="mt-1 flex flex-col gap-2">
                  {mutations.map((col) => (
                    <div key={col.objectKey} className="rounded border border-slate-800 px-2 py-1.5">
                      <div className="text-[11px] font-semibold text-slate-200">{col.columnName}</div>
                      <ol className="mt-1 flex flex-col gap-1">
                        {col.events.map((point) => (
                          <HistoryEvent key={`${point.versionId}:${point.operation}`} point={point} />
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              ) : data.history.length === 0 ? (
                <p className="mt-1 text-[11px] text-slate-500">No recorded changes for this object.</p>
              ) : (
                <ol className="mt-1 flex flex-col gap-1.5">
                  {data.history.map((point) => (
                    <HistoryEvent key={`${point.versionId}:${point.operation}`} point={point} />
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
