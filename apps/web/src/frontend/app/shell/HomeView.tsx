/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Home: continue last work, recents, and saved connections from Zustand only —
 * no schema introspect.
 */
import React from 'react';
import { Camera, Database, GitCompareArrows, Search, Terminal, Wrench } from 'lucide-react';
import { openRecentQuery, selectEditorConnection, useRecentQueries } from '@/features/sql-editor';
import { useSyncStore } from '@/features/compare';
import { useUiStore } from '@/app/store/uiStore';
import { formatRelativeDay } from '@/shared/lib/relativeTime';
import { openCommandPalette } from './commandPaletteEvent';
import { diffBriefing } from '@/features/schema-diff';
import { dialectLabel } from '@/shared/lib/dialectLabel';

function previewSql(sql: string): string {
  const line = sql.trim().split('\n')[0] ?? '';
  return line.length > 88 ? `${line.slice(0, 87)}…` : line;
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

  const openConnection = (id: string) => {
    void selectEditorConnection(id);
    setActiveView('sqlEditor');
  };

  const briefing = diffBriefing(compareResult?.tables);
  const lastQuery = recentQueries[0];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6" data-testid="home-view">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-100">Home</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Continue where you left off. Opening a recent or connection does not introspect a database.
          </p>
        </div>
        <button
          type="button"
          data-testid="home-command-palette"
          onClick={() => openCommandPalette()}
          className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950 px-3 py-1.5 text-[12px] font-semibold text-slate-300 hover:border-slate-500 hover:text-slate-100"
        >
          <Search className="h-3.5 w-3.5" />
          Search workspaces and recents
          <kbd className="rounded border border-slate-700 bg-slate-900 px-1.5 font-mono text-[10px] text-slate-500">
            ⌘K
          </kbd>
        </button>
      </div>

      <section className="mt-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid="home-continue">
        <button
          type="button"
          data-testid="home-continue-sync"
          disabled={!compareResult}
          onClick={() => setActiveView('sync')}
          className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-left hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <GitCompareArrows className="h-3.5 w-3.5" /> Last compare
          </span>
          <span className="mt-2 block text-[13px] font-semibold text-slate-100">
            {compareResult
              ? `+${briefing.added}  ~${briefing.modified}  −${briefing.removed}`
              : 'No compare yet'}
          </span>
          <span className="mt-1 block truncate font-mono text-[11px] text-slate-500">
            {compareResult
              ? `${sourceConfig.option.database ?? 'Original'} → ${targetConfig.option.database ?? 'Target'}`
              : 'Run Compare'}
          </span>
        </button>
        <button
          type="button"
          data-testid="home-continue-sql"
          disabled={!lastQuery}
          onClick={() => lastQuery && openRecent(lastQuery.id)}
          className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-left hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <Terminal className="h-3.5 w-3.5" /> Last query
          </span>
          <span className="mt-2 block truncate text-[13px] font-semibold text-slate-100">
            {lastQuery?.title?.trim() || (lastQuery ? 'Query' : 'No query yet')}
          </span>
          <span className="mt-1 block truncate font-mono text-[11px] text-slate-500">
            {lastQuery ? previewSql(lastQuery.sql) : 'Run SQL to see it here'}
          </span>
        </button>
        <button
          type="button"
          data-testid="home-continue-snapshots"
          onClick={() => setActiveView('snapshots')}
          className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-left hover:border-slate-600"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <Camera className="h-3.5 w-3.5" /> Snapshots
          </span>
          <span className="mt-2 block text-[13px] font-semibold text-slate-100">Schema history</span>
          <span className="mt-1 block text-[11px] text-slate-500">Timeline, briefing, and compare pane</span>
        </button>
        <button
          type="button"
          data-testid="home-continue-utilities"
          onClick={() => setActiveView('utilities')}
          className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-left hover:border-slate-600"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            <Wrench className="h-3.5 w-3.5" /> Utilities
          </span>
          <span className="mt-2 block text-[13px] font-semibold text-slate-100">
            Database tools
          </span>
          <span className="mt-1 block text-[11px] text-slate-500">
            Indexes, clone table, insights, and query files
          </span>
        </button>
      </section>

      <section className="mt-6" data-testid="home-recents">
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-2">
          Recent queries
        </h2>
        {recentQueries.length === 0 ? (
          <p className="text-[12px] text-slate-500" data-testid="home-recents-empty">
            Run a query in the SQL Editor to see it here.
          </p>
        ) : (
          <ul className="space-y-1">
            {recentQueries.slice(0, 12).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid={`home-recent-${r.id}`}
                  onClick={() => openRecent(r.id)}
                  className="w-full text-left rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2 hover:border-slate-600 hover:bg-slate-900"
                >
                  <span className="flex items-center gap-2">
                    <Terminal className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span className="text-[12px] font-semibold text-slate-100 truncate">
                      {r.title?.trim() || 'Query'}
                    </span>
                    <span className="ml-auto text-[10px] text-slate-500 shrink-0">
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

      <section className="mt-6" data-testid="home-connections">
        <h2 className="mb-2 flex items-baseline gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <span>Connections by provider</span>
          <span
            data-testid="home-connections-count"
            className="rounded-full border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold normal-case tracking-normal text-slate-300"
          >
            {connections.length}
          </span>
        </h2>
        {connections.length === 0 ? (
          <p className="text-[12px] text-slate-500">Save a connection from Compare to see it here.</p>
        ) : (
          <div className="space-y-4">
            {[...connections]
              .sort(
                (a, b) =>
                  dialectLabel(a.dialect).localeCompare(dialectLabel(b.dialect)) ||
                  (a.name || '').localeCompare(b.name || '')
              )
              .reduce<Array<{ dialect: string; label: string; items: typeof connections }>>(
                (groups, c) => {
                  const key = c.dialect.toLowerCase();
                  const last = groups[groups.length - 1];
                  if (last && last.dialect === key) {
                    last.items = [...last.items, c];
                  } else {
                    groups.push({ dialect: key, label: dialectLabel(c.dialect), items: [c] });
                  }
                  return groups;
                },
                []
              )
              .map((group) => (
                <div key={group.dialect} data-testid={`home-connections-group-${group.dialect}`}>
                  <h3 className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                    {group.label}
                    <span className="ml-1.5 font-mono text-[10px] font-semibold normal-case tracking-normal text-slate-600">
                      {group.items.length}
                    </span>
                  </h3>
                  <ul className="flex flex-wrap gap-2">
                    {group.items.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          data-testid={`home-connection-${c.id}`}
                          onClick={() => openConnection(c.id)}
                          title={[
                            dialectLabel(c.dialect),
                            c.name,
                            c.host && (c.port ? `${c.host}:${c.port}` : c.host),
                            c.database,
                            c.username,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                          className="inline-flex max-w-full items-center gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-2.5 py-1.5 text-[12px] font-semibold text-slate-200 hover:border-slate-600"
                        >
                          <Database className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                          <span className="truncate">{c.name}</span>
                          <span className="shrink-0 rounded border border-slate-700/80 bg-slate-950/80 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">
                            {dialectLabel(c.dialect)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
};
