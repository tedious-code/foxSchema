/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Default Snapshots workspace: a version list from GET /versions, not the
 * React Flow graph (that reconstructs object nodes and is opt-in).
 */
import React from 'react';
import type { VersionGraphVersion } from '@foxschema/shared';
import { DiffBriefingTicks } from '@/features/schema-diff';
import { formatRelativeDay } from '@/shared/lib/relativeTime';

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
}

export function VersionTimeline({
  versions,
  totalVersions,
  selectedId,
  subtitle,
  onSelect,
}: VersionTimelineProps): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pt-2" data-testid="lokee-timeline">
      <header
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400"
        data-testid="lokee-summary"
      >
        <span className="font-semibold text-slate-300">Schema history</span>
        <span className="text-slate-600">·</span>
        <span>
          <span className="font-bold text-slate-100">{totalVersions}</span> versions
        </span>
        {subtitle && <span className="truncate text-slate-600">{subtitle}</span>}
      </header>
      <ol className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pb-4">
        {versions.map((version) => {
          const selected = version.id === selectedId;
          const added = version.added ?? 0;
          const modified = version.modified ?? 0;
          const removed = version.removed ?? 0;
          const changes = added + modified + removed || version.changeCount || 0;
          return (
            <li key={version.id}>
              <button
                type="button"
                data-testid={`lokee-timeline-v-${version.number}`}
                onClick={() => onSelect?.(version.id)}
                className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition ${
                  selected
                    ? 'border-cyan-500/40 bg-cyan-950/30'
                    : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                }`}
              >
                <span className="w-16 shrink-0 text-xs font-bold text-slate-200">
                  v{version.number}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
                  {version.name || version.source}
                  {changes > 0 ? ` · ${changes} changes` : ''}
                  {version.author ? ` · ${version.author}` : ''}
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
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
