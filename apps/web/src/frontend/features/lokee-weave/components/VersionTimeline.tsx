/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Default Snapshots workspace: a version list from GET /versions, not the
 * React Flow graph (that reconstructs object nodes and is opt-in).
 */
import React, { useMemo, useState } from 'react';
import { ArrowRight, Check, Pencil, Search, X } from 'lucide-react';
import type { VersionGraphVersion } from '@foxschema/shared';
import { DiffBriefingTicks } from '@/features/schema-diff';
import { formatRelativeDay } from '@/shared/lib/relativeTime';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';

export type TimelineVersion = VersionGraphVersion & {
  changeCount?: number;
  added?: number;
  modified?: number;
  removed?: number;
};

export interface VersionTimelineProps {
  versions: readonly TimelineVersion[];
  totalVersions: number;
  selectedId?: string | null;
  subtitle?: string;
  onSelect?: (versionId: string) => void;
  onSaveVersionMeta?: (
    versionId: string,
    patch: { name: string; description: string }
  ) => Promise<void>;
}

export function VersionTimeline({
  versions,
  totalVersions,
  selectedId,
  subtitle,
  onSelect,
  onSaveVersionMeta,
}: VersionTimelineProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [saving, setSaving] = useState(false);

  const filteredVersions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return versions;
    return versions.filter((v) => {
      const hay = [
        `v${v.number}`,
        String(v.number),
        v.name ?? '',
        v.description ?? '',
        v.author ?? '',
        v.source ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [versions, query]);

  const startEdit = (version: TimelineVersion) => {
    setEditingId(version.id);
    setEditName(version.name ?? '');
    setEditDesc(version.description ?? '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditDesc('');
  };

  const commitEdit = async (versionId: string) => {
    if (!onSaveVersionMeta || saving) return;
    setSaving(true);
    try {
      await onSaveVersionMeta(versionId, { name: editName, description: editDesc });
      setEditingId(null);
    } catch {
      /* parent shows toast */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pt-2" data-testid="lokee-timeline">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <header
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400"
          data-testid="lokee-summary"
        >
          <span className="font-semibold text-slate-300">Schema history</span>
          <span className="text-slate-600">·</span>
          <span>
            <span className="font-bold text-slate-100">{totalVersions}</span> versions
          </span>
          {query.trim() && (
            <span className="text-cyan-400">
              ({filteredVersions.length} matching)
            </span>
          )}
          {subtitle && <span className="truncate text-slate-500">{subtitle}</span>}
        </header>
        {versions.length > 0 && (
          <div className="relative flex items-center">
            <Search
              className="pointer-events-none absolute left-2 h-3 w-3 text-slate-500"
              strokeWidth={SQL_ICON_STROKE}
            />
            <input
              type="text"
              data-testid="lokee-timeline-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter versions, labels, authors…"
              className="w-56 rounded-md border border-slate-800 bg-slate-950/70 py-1 pl-6 pr-6 text-[11px] text-slate-200 placeholder:text-slate-500 focus:border-cyan-500/50 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                data-testid="lokee-timeline-search-clear"
                onClick={() => setQuery('')}
                title="Clear filter"
                aria-label="Clear version filter"
                className="absolute right-1.5 text-slate-500 hover:text-slate-200"
              >
                <X className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
              </button>
            )}
          </div>
        )}
      </div>

      <ol className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pb-4">
        {filteredVersions.length === 0 && query.trim() ? (
          <li className="rounded-md border border-slate-800/80 bg-slate-950/40 px-4 py-6 text-center text-xs text-slate-400">
            No versions match &ldquo;{query.trim()}&rdquo;.
          </li>
        ) : (
          filteredVersions.map((version) => {
            const selected = version.id === selectedId;
            const isEditing = editingId === version.id;
            const added = version.added ?? 0;
            const modified = version.modified ?? 0;
            const removed = version.removed ?? 0;
            const changes = added + modified + removed || version.changeCount || 0;
            return (
              <li key={version.id} className="space-y-1">
                <div
                  className={`group flex items-center gap-1 rounded-md border transition ${
                    selected
                      ? 'border-cyan-500/40 bg-cyan-950/30'
                      : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                  }`}
                >
                  <button
                    type="button"
                    data-testid={`lokee-timeline-v-${version.number}`}
                    onClick={() => onSelect?.(version.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
                  >
                    <span className="w-14 shrink-0 text-xs font-bold text-slate-200">
                      v{version.number}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-slate-300">
                        {version.name || version.source || 'Snapshot'}
                        {changes > 0 ? ` · ${changes} changes` : ''}
                        {version.author ? ` · ${version.author}` : ''}
                      </span>
                      {version.description && (
                        <span className="mt-0.5 block truncate text-[10px] text-slate-500">
                          {version.description}
                        </span>
                      )}
                    </span>
                    <span
                      className="shrink-0 text-[10px] text-slate-500"
                      title={new Date(version.createdAt).toLocaleString()}
                    >
                      {Number.isFinite(Date.parse(version.createdAt))
                        ? formatRelativeDay(Date.parse(version.createdAt))
                        : version.createdAt}
                    </span>
                    <DiffBriefingTicks added={added} modified={modified} removed={removed} />
                    <span
                      className={`hidden sm:inline-flex shrink-0 items-center gap-0.5 text-[10px] font-semibold transition ${
                        selected
                          ? 'text-cyan-300 opacity-100'
                          : 'text-slate-400 opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      Compare
                      <ArrowRight className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
                    </span>
                  </button>
                  {onSaveVersionMeta && (
                    <button
                      type="button"
                      data-testid={`lokee-timeline-edit-${version.number}`}
                      onClick={() => (isEditing ? cancelEdit() : startEdit(version))}
                      title="Rename or add notes"
                      aria-label={`Edit version ${version.number}`}
                      className={`mr-2 shrink-0 rounded p-1.5 transition ${
                        isEditing
                          ? 'bg-cyan-950/60 text-cyan-300'
                          : 'text-slate-500 opacity-60 hover:bg-slate-800 hover:text-slate-200 group-hover:opacity-100'
                      }`}
                    >
                      <Pencil className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
                    </button>
                  )}
                </div>

                {isEditing && onSaveVersionMeta && (
                  <div
                    data-testid={`lokee-timeline-edit-form-${version.number}`}
                    className="ml-4 flex flex-col gap-2 rounded-md border border-cyan-500/30 bg-slate-900/90 p-2.5 text-[11px]"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        cancelEdit();
                      }
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        data-testid="lokee-timeline-edit-name"
                        maxLength={120}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void commitEdit(version.id);
                          }
                        }}
                        placeholder={`Label for v${version.number} (e.g. Before billing release)`}
                        className="min-w-[14rem] flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100 focus:border-cyan-500/60 focus:outline-none"
                      />
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          data-testid="lokee-timeline-edit-save"
                          disabled={saving}
                          onClick={() => void commitEdit(version.id)}
                          className="inline-flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-950/50 px-2.5 py-1 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-900/50 disabled:opacity-40"
                        >
                          <Check className="h-3 w-3" strokeWidth={SQL_ICON_STROKE} />
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          data-testid="lokee-timeline-edit-cancel"
                          disabled={saving}
                          onClick={cancelEdit}
                          className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    <textarea
                      data-testid="lokee-timeline-edit-desc"
                      maxLength={4000}
                      rows={2}
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      placeholder="Optional notes for this version…"
                      className="resize-y rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 focus:border-cyan-500/60 focus:outline-none"
                    />
                  </div>
                )}
              </li>
            );
          })
        )}
      </ol>
    </div>
  );
}
