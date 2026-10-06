/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local ⌘K palette: workspaces, saved connections, recent queries.
 * Nothing here hits the network or introspects a schema.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '@/app/store/authStore';
import { openRecentQuery, selectEditorConnection, useRecentQueries } from '@/app/store/recentQueries';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useUiStore, type ActiveView } from '@/app/store/uiStore';
import { COMMAND_PALETTE_EVENT } from './commandPaletteEvent';

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

export const CommandPalette: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const connections = useSyncStore((s) => s.connections);
  // Not the SQL editor store: that loads with the editor, not with the shell.
  const recentQueries = useRecentQueries((s) => s.recentQueries);
  const canSchemaBrowse = useAuthStore((s) => s.can('schema.browse'));
  const canSchemaCompare = useAuthStore((s) => s.can('schema.compare'));
  const canEditorAccess = useAuthStore((s) => s.can('editor.access'));
  const canUtilityAccess = useAuthStore((s) => s.can('utility.access'));
  const canAccess = useAuthStore((s) => s.can('access.access'));
  const canWorkflow = useAuthStore((s) => s.can('workflow.access'));

  const go = (view: ActiveView) => {
    setActiveView(view);
    setOpen(false);
  };

  const items = useMemo((): PaletteItem[] => {
    const out: PaletteItem[] = [
      { id: 'ws-home', group: 'Workspace', label: 'Home', run: () => go('home') },
    ];
    if (canSchemaBrowse || canSchemaCompare) {
      out.push({ id: 'ws-sync', group: 'Workspace', label: 'Compare', run: () => go('sync') });
    }
    if (canEditorAccess) {
      out.push({
        id: 'ws-sql',
        group: 'Workspace',
        label: 'SQL Editor',
        run: () => go('sqlEditor'),
      });
    }
    if (canUtilityAccess) {
      out.push({
        id: 'ws-utilities',
        group: 'Workspace',
        label: 'Utilities',
        run: () => go('utilities'),
      });
    }
    if (canAccess) {
      out.push({ id: 'ws-access', group: 'Workspace', label: 'Access', run: () => go('access') });
    }
    if (canWorkflow) {
      out.push({
        id: 'ws-workflow',
        group: 'Workspace',
        label: 'Workflow',
        run: () => go('workflow'),
      });
    }
    if (canSchemaBrowse) {
      out.push({
        id: 'ws-snapshots',
        group: 'Workspace',
        label: 'Snapshots',
        run: () => go('snapshots'),
      });
    }
    out.push({
      id: 'ws-settings',
      group: 'Workspace',
      label: 'Preferences',
      run: () => go('settings'),
    });
    for (const c of connections) {
      out.push({
        id: `conn-${c.id}`,
        group: 'Connection',
        label: c.name,
        hint: c.dialect,
        run: () => {
          void selectEditorConnection(c.id);
          go('sqlEditor');
        },
      });
    }
    for (const r of recentQueries.slice(0, 12)) {
      out.push({
        id: `recent-${r.id}`,
        group: 'Recent',
        label: r.title?.trim() || 'Query',
        hint: r.sql.trim().split('\n')[0],
        run: () => {
          void openRecentQuery(r.id);
          go('sqlEditor');
        },
      });
    }
    return out;
    // go closes over setActiveView; items rebuild when catalogs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canSchemaBrowse,
    canSchemaCompare,
    canEditorAccess,
    canUtilityAccess,
    canAccess,
    canWorkflow,
    connections,
    recentQueries,
    setActiveView,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.group.toLowerCase().includes(q) ||
        (it.hint ?? '').toLowerCase().includes(q)
    );
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((v) => !v);
        setQuery('');
      }
    };
    const onOpen = () => {
      setOpen(true);
      setQuery('');
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener(COMMAND_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener(COMMAND_PALETTE_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(filtered.length - 1, i + 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        filtered[active]?.run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, active]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex items-start justify-center bg-black/55 p-4 pt-[12vh]"
      data-testid="command-palette"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          data-testid="command-palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Go to a workspace, connection, or recent query…"
          className="w-full bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none border-b border-slate-800"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-[12px] text-slate-500">No matches.</li>
          )}
          {filtered.map((it, i) => (
            <li key={it.id}>
              <button
                type="button"
                data-testid={`command-palette-item-${it.id}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => it.run()}
                className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 ${
                  i === active ? 'bg-slate-800 text-slate-50' : 'text-slate-200'
                }`}
              >
                <span className="text-[10px] uppercase tracking-wide text-slate-500 w-20 shrink-0">
                  {it.group}
                </span>
                <span className="truncate font-semibold">{it.label}</span>
                {it.hint && (
                  <span className="ml-auto truncate text-[11px] text-slate-500 max-w-[40%]">
                    {it.hint}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  );
};
