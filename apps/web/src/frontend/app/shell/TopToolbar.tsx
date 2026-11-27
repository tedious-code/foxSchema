/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The top toolbar. The active view supplies its part through the registry
 * (`toolbar` on its definition); the shell adds what every view has, the
 * background-activity indicator and the command palette.
 */
import React, { useEffect, useState } from 'react';
import { HelpCircle, Moon, Search, Sun } from 'lucide-react';
import { useUiStore, type ActiveView } from '@/platform/uiStore';
import { WORKSPACE_VIEWS } from '@/app/features/featureRegistry';
import { ActivityIndicator } from './ActivityIndicator';
import { openCommandPalette } from './commandPaletteEvent';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';

const VIEW_HEADERS: Record<ActiveView, { title: string; subtitle: string }> = {
  home: { title: 'Home', subtitle: 'Overview & quick launch' },
  sync: { title: 'Compare', subtitle: 'Schema diff & migration' },
  sqlEditor: { title: 'SQL Editor', subtitle: 'Query, inspect & compare data' },
  utilities: { title: 'Utilities', subtitle: 'Indexes, clones, insights & files' },
  access: { title: 'Access', subtitle: 'Database users, roles & grants' },
  workflow: { title: 'Workflows', subtitle: 'Automated ETL, ELT & DBA pipelines' },
  snapshots: { title: 'Snapshots', subtitle: 'Schema history & timeline' },
  settings: { title: 'Settings', subtitle: 'Appearance, database & security' },
};

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  return Boolean(el.closest?.('.monaco-editor'));
}

export const TopToolbar: React.FC = () => {
  const activeView = useUiStore((s) => s.activeView);
  const resolvedMode = useUiStore((s) => s.resolvedMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { start: Start, end: End, below: Below } = WORKSPACE_VIEWS[activeView].toolbar ?? {};
  const header = VIEW_HEADERS[activeView];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggleTheme = () => {
    setThemeMode(resolvedMode === 'light' ? 'dark' : 'light');
  };

  return (
    <>
      <header data-testid="toolbar" className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-3 py-1 flex flex-col gap-1">
        <div className="flex min-h-9 flex-wrap items-center gap-1.5">
          {Start ? (
            <Start />
          ) : (
            <div data-testid="toolbar-view-title" className="flex items-baseline gap-2 pl-1">
              <span className="text-xs font-bold text-slate-100">{header.title}</span>
              <span className="hidden text-[11px] text-slate-400 md:inline">{header.subtitle}</span>
            </div>
          )}

          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
            <ActivityIndicator />
            <button
              type="button"
              data-testid="command-palette-btn"
              onClick={() => openCommandPalette()}
              title="Command palette (⌘K)"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:border-slate-500 hover:text-slate-100 cursor-pointer transition"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden rounded border border-slate-700 bg-slate-950 px-1 font-mono text-[9px] text-slate-400 sm:inline">
                ⌘K
              </kbd>
            </button>
            <button
              type="button"
              data-testid="toolbar-theme-toggle"
              onClick={toggleTheme}
              aria-label={resolvedMode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              title={resolvedMode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700/80 text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-slate-100 cursor-pointer transition"
            >
              {resolvedMode === 'light' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              data-testid="toolbar-shortcuts-btn"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700/80 text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-slate-100 cursor-pointer transition"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>
            {End && <End />}
          </div>
        </div>

        {Below && <Below />}
      </header>
      <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </>
  );
};
