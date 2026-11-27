/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Home: continue last work, recents, and saved connections from Zustand only —
 * no schema introspect.
 */
import React, { useState } from 'react';
import {
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronRight,
  Database,
  GitCompareArrows,
  Search,
  Sparkles,
  Terminal,
  Workflow,
  Wrench,
} from 'lucide-react';
import { openRecentQuery, useRecentQueries } from '@/features/sql-editor';
import { useSyncStore } from '@/features/compare';
import { useUiStore } from '@/platform/uiStore';
import { formatRelativeDay } from '@/shared/lib/relativeTime';
import { openCommandPalette } from './commandPaletteEvent';
import { ServiceStatusCard } from './ServiceStatusCard';
import { DriverInventoryCard } from './DriverInventoryCard';
import { diffBriefing } from '@/features/schema-diff';
import { dialectLabel } from '@/shared/lib/dialectLabel';

function previewSql(sql: string): string {
  const line = sql.trim().split('\n')[0] ?? '';
  return line.length > 88 ? `${line.slice(0, 87)}…` : line;
}

function connectionsByProvider(
  connections: Array<{ dialect: string }>
): Array<{ dialect: string; label: string; count: number }> {
  const counts = new Map<string, { dialect: string; label: string; count: number }>();
  for (const connection of connections) {
    const dialect = connection.dialect.toLowerCase();
    const row = counts.get(dialect);
    if (row) row.count += 1;
    else counts.set(dialect, { dialect, label: dialectLabel(connection.dialect), count: 1 });
  }
  return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export const HomeView: React.FC = () => {
  // Not the SQL editor store: that loads with the editor, not with Home.
  const recentQueries = useRecentQueries((s) => s.recentQueries);
  const connections = useSyncStore((s) => s.connections);
  const compareResult = useSyncStore((s) => s.compareResult);
  const sourceConfig = useSyncStore((s) => s.sourceConfig);
  const targetConfig = useSyncStore((s) => s.targetConfig);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const openRecent = (id: string) => {
    void openRecentQuery(id);
    setActiveView('sqlEditor');
  };

  const [systemOpen, setSystemOpen] = useState(true);

  const briefing = diffBriefing(compareResult?.tables);
  const lastQuery = recentQueries[0];
  const providerCounts = connectionsByProvider(connections);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6" data-testid="home-view">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-100">Welcome to FoxSchema</h1>
            <p className="mt-1 text-xs text-slate-400">
              Pick up where you left off or jump straight into comparing schemas, querying data, or running workflows.
            </p>
          </div>
          <button
            type="button"
            data-testid="home-command-palette"
            onClick={() => openCommandPalette()}
            className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950 px-3 py-1.5 text-[12px] font-semibold text-slate-300 hover:border-slate-500 hover:text-slate-100 cursor-pointer transition"
          >
            <Search className="h-3.5 w-3.5" />
            Quick jump
            <kbd className="rounded border border-slate-700 bg-slate-900 px-1.5 font-mono text-[10px] text-slate-400">
              ⌘K
            </kbd>
          </button>
        </div>

        {connections.length === 0 && (
          <section
            data-testid="home-getting-started"
            className="mt-5 rounded-xl border border-cyan-500/25 bg-gradient-to-r from-cyan-950/35 via-slate-900/60 to-slate-900/40 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="flex items-center gap-1.5 text-xs font-bold text-cyan-300">
                  <Sparkles className="h-3.5 w-3.5" /> Quick Start
                </p>
                <p className="text-sm font-semibold text-slate-100">
                  Connect your first database or try a zero-setup workflow sample
                </p>
                <p className="text-xs text-slate-400">
                  Add any SQL, SQLite, DuckDB, or NoSQL connection from Compare or Connect in the left bar — or explore built-in sample workflows immediately.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="home-start-compare"
                  onClick={() => setActiveView('sync')}
                  className="inline-flex items-center gap-1.5 rounded-lg accent-grad on-accent-fg px-3.5 py-2 text-xs font-bold shadow-sm cursor-pointer hover:brightness-110 transition"
                >
                  Connect &amp; Compare <ArrowRight className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  data-testid="home-start-workflow"
                  onClick={() => setActiveView('workflow')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500 cursor-pointer transition"
                >
                  <Workflow className="h-3.5 w-3.5 text-cyan-400" /> Try Sample Workflows
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="mt-6 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5" data-testid="home-continue">
          <button
            type="button"
            data-testid="home-continue-sync"
            onClick={() => setActiveView('sync')}
            className="group rounded-xl border border-slate-800 bg-slate-900/45 p-3.5 text-left transition cursor-pointer hover:border-cyan-500/40 hover:bg-slate-900/80"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-cyan-400">
              <GitCompareArrows className="h-3.5 w-3.5" /> Compare
            </span>
            <span className="mt-2 block text-[13px] font-semibold text-slate-100">
              {compareResult
                ? `+${briefing.added}  ~${briefing.modified}  −${briefing.removed}`
                : 'Schema diff & sync'}
            </span>
            <span className="mt-1 block truncate font-mono text-[11px] text-slate-400">
              {compareResult
                ? `${sourceConfig.option.database ?? 'Source'} → ${targetConfig.option.database ?? 'Target'}`
                : 'Pick two databases to compare'}
            </span>
          </button>
          <button
            type="button"
            data-testid="home-continue-sql"
            onClick={() => (lastQuery ? openRecent(lastQuery.id) : setActiveView('sqlEditor'))}
            className="group rounded-xl border border-slate-800 bg-slate-900/45 p-3.5 text-left transition cursor-pointer hover:border-emerald-500/40 hover:bg-slate-900/80"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-400">
              <Terminal className="h-3.5 w-3.5" /> SQL Editor
            </span>
            <span className="mt-2 block truncate text-[13px] font-semibold text-slate-100">
              {lastQuery?.title?.trim() || (lastQuery ? 'Resume last query' : 'Write & run SQL')}
            </span>
            <span className="mt-1 block truncate font-mono text-[11px] text-slate-400">
              {lastQuery ? previewSql(lastQuery.sql) : 'Query, chart, and edit rows'}
            </span>
          </button>
          <button
            type="button"
            data-testid="home-continue-snapshots"
            onClick={() => setActiveView('snapshots')}
            className="group rounded-xl border border-slate-800 bg-slate-900/45 p-3.5 text-left transition cursor-pointer hover:border-sky-500/40 hover:bg-slate-900/80"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-sky-400">
              <Camera className="h-3.5 w-3.5" /> Snapshots
            </span>
            <span className="mt-2 block text-[13px] font-semibold text-slate-100">Schema history</span>
            <span className="mt-1 block text-[11px] text-slate-400">Timeline, briefing, and drift checks</span>
          </button>
          <button
            type="button"
            data-testid="home-continue-utilities"
            onClick={() => setActiveView('utilities')}
            className="group rounded-xl border border-slate-800 bg-slate-900/45 p-3.5 text-left transition cursor-pointer hover:border-amber-500/40 hover:bg-slate-900/80"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-400">
              <Wrench className="h-3.5 w-3.5" /> Utilities
            </span>
            <span className="mt-2 block text-[13px] font-semibold text-slate-100">
              Database tools
            </span>
            <span className="mt-1 block text-[11px] text-slate-400">
              Indexes, clone table, insights &amp; files
            </span>
          </button>
          <button
            type="button"
            data-testid="home-continue-workflow"
            onClick={() => setActiveView('workflow')}
            className="group rounded-xl border border-slate-800 bg-slate-900/45 p-3.5 text-left transition cursor-pointer hover:border-violet-500/40 hover:bg-slate-900/80"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-violet-400">
              <Workflow className="h-3.5 w-3.5" /> Workflows
            </span>
            <span className="mt-2 block text-[13px] font-semibold text-slate-100">
              Pipelines &amp; automation
            </span>
            <span className="mt-1 block text-[11px] text-slate-400">
              ELT, data migration &amp; DBA audits
            </span>
          </button>
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section data-testid="home-recents">
            <h2 className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-2">
              Recent queries
            </h2>
            {recentQueries.length === 0 ? (
              <div
                className="rounded-lg border border-dashed border-slate-800 bg-slate-900/30 px-4 py-5 text-xs text-slate-400"
                data-testid="home-recents-empty"
              >
                <p>No recent queries yet — run a query in the SQL Editor and it will appear here.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {recentQueries.slice(0, 8).map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      data-testid={`home-recent-${r.id}`}
                      onClick={() => openRecent(r.id)}
                      className="w-full text-left rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 hover:border-slate-600 hover:bg-slate-900 transition cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <Terminal className="w-3.5 h-3.5 text-emerald-400/80 shrink-0" />
                        <span className="text-[12px] font-semibold text-slate-100 truncate">
                          {r.title?.trim() || 'Query'}
                        </span>
                        <span className="ml-auto text-[11px] text-slate-400 shrink-0">
                          {formatRelativeDay(r.ranAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-slate-400 truncate">
                        {previewSql(r.sql)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="home-connections">
            <h2 className="mb-2 flex items-baseline gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
              <span>Connections by provider</span>
              <span
                data-testid="home-connections-count"
                className="rounded-full border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold normal-case tracking-normal text-slate-300"
              >
                {connections.length}
              </span>
            </h2>
            {connections.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/30 px-4 py-5 text-xs text-slate-400">
                <p>No saved connections yet. Click Connect in the left bar or Compare to save your first database.</p>
              </div>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {providerCounts.map((group) => (
                  <li key={group.dialect}>
                    <button
                      type="button"
                      data-testid={`home-connections-group-${group.dialect}`}
                      aria-label={`${group.label}: ${group.count} saved`}
                      onClick={() => setActiveView('sync')}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/45 px-3 py-2 text-[12px] font-semibold text-slate-200 hover:border-cyan-500/40 hover:bg-slate-900 transition cursor-pointer"
                    >
                      <Database className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                      <span>{group.label}</span>
                      <span
                        data-testid={`home-connections-count-${group.dialect}`}
                        className="rounded-full border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-300"
                      >
                        {group.count}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="mt-8 border-t border-slate-800/80 pt-4">
          <button
            type="button"
            data-testid="home-system-toggle"
            aria-expanded={systemOpen}
            onClick={() => setSystemOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer transition"
          >
            {systemOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span>System status &amp; database drivers</span>
          </button>
          {systemOpen && (
            <div>
              <ServiceStatusCard />
              <DriverInventoryCard />
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
