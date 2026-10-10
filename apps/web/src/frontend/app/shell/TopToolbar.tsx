/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The top toolbar. The active view supplies its part through the registry
 * (`toolbar` on its definition); the shell adds what every view has, the
 * background-activity indicator and the command palette.
 */
import React from 'react';
import { Search } from 'lucide-react';
import { useUiStore } from '@/app/store/uiStore';
import { WORKSPACE_VIEWS } from '@/app/features/featureRegistry';
import { ActivityIndicator } from './ActivityIndicator';
import { openCommandPalette } from './commandPaletteEvent';

export const TopToolbar: React.FC = () => {
  const activeView = useUiStore((s) => s.activeView);
  const { start: Start, end: End, below: Below } = WORKSPACE_VIEWS[activeView].toolbar ?? {};

  return (
    <header data-testid="toolbar" className="border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-3 py-1 flex flex-col gap-1">
      <div className="flex min-h-9 flex-wrap items-center gap-1.5">
        {Start && <Start />}

        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
          <ActivityIndicator />
          <button
            type="button"
            data-testid="command-palette-btn"
            onClick={() => openCommandPalette()}
            title="Command palette (⌘K)"
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-100"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border border-slate-700 bg-slate-950 px-1 font-mono text-[9px] text-slate-500 sm:inline">
              ⌘K
            </kbd>
          </button>
          {End && <End />}
        </div>
      </div>

      {Below && <Below />}
    </header>
  );
};
