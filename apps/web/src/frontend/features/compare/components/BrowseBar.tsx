/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Browse's toolbar: one database, nothing else.
 *
 * Browse used to borrow Compare's bar — two connection cards, a swap arrow, a
 * direction label — for a pane that reads a single schema and has no direction
 * at all. Half those controls were meaningless here, and the "Browse" buttons
 * that started the read were buried on the Original/Target cards, which is why
 * nobody found them.
 *
 * Picking a connection loads it. That is the whole interaction.
 */
import React from 'react';
import { Loader2, Search } from 'lucide-react';
import { dialectLabel } from '@/shared/lib/dialectLabel';
import { FilterPicker, connectionPickerOption } from '@/shared/components/FilterPicker';
import { useSyncStore } from '@/features/compare/state/useSyncStore';
import { getSessionPassword } from '@/shared/lib/sessionPasswords';

export function BrowseBar(): React.ReactElement {
  const connections = useSyncStore((s) => s.connections);
  const sourceConfig = useSyncStore((s) => s.sourceConfig);
  const isBrowsing = useSyncStore((s) => s.isBrowsing);
  const browseMode = useSyncStore((s) => s.browseMode);
  const selectedObjectTypes = useSyncStore((s) => s.selectedObjectTypes);
  const applySavedConnection = useSyncStore((s) => s.applySavedConnection);
  const browseSchema = useSyncStore((s) => s.browseSchema);

  const selectedId = sourceConfig.connectionId ?? '';
  const selected = connections.find((c) => c.id === selectedId);

  /**
   * Browsing reads through the `source` side because that is where the store's
   * connection config lives; the user never sees a side here. A saved
   * connection with no stored password can still be browsed if this session
   * already unlocked it — same rule Compare uses.
   */
  const onPick = (id: string) => {
    if (!id) return;
    const conn = connections.find((c) => c.id === id);
    if (!conn) return;
    const password = conn.hasPassword ? undefined : getSessionPassword(id);
    applySavedConnection('source', id, password);
    void browseSchema('source');
  };

  const label = sourceConfig.option.database
    ? `${dialectLabel(sourceConfig.dialect)} · ${[sourceConfig.option.host, sourceConfig.option.database]
        .filter(Boolean)
        .join('/')}${sourceConfig.schema ? `.${sourceConfig.schema}` : ''}`
    : null;

  const pickerSummary = selected
    ? `${selected.name || '(unnamed)'} · ${dialectLabel(selected.dialect)}`
    : connections.length === 0
      ? 'No saved connections'
      : 'Pick a database…';

  return (
    <div
      data-testid="browse-bar"
      className="flex flex-wrap items-center gap-3 rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2"
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-500/80">
        Database
      </span>
      <FilterPicker
        mode="single"
        testId="browse-connection-select"
        className="min-w-0 flex-1 max-w-md"
        disabled={connections.length === 0 || isBrowsing}
        options={connections.map((c) => ({
          ...connectionPickerOption(c),
          testId: `browse-connection-option-${c.id}`,
        }))}
        selectedId={selectedId || null}
        onSelect={onPick}
        clearLabel="Pick a database…"
        summary={pickerSummary}
        title="Read this database's objects — search by name, host, database, user, or port"
        placeholder="Search name, host, db, user, port…"
        triggerClassName="flex w-full min-w-0 items-center gap-1.5 rounded border border-slate-700/60 bg-slate-900 px-2 py-1 text-left text-xs text-slate-200 accent-focus focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      />

      <button
        type="button"
        data-testid="browse-reload-btn"
        disabled={!selectedId || isBrowsing || selectedObjectTypes.length === 0}
        onClick={() => void browseSchema('source')}
        title="Re-read this database"
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-950/30 px-2.5 py-0.5 text-xs font-medium text-cyan-400 transition hover:border-cyan-400/60 hover:bg-cyan-950/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isBrowsing ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Search className="w-3.5 h-3.5" />
        )}
        {isBrowsing ? 'Reading…' : browseMode ? 'Reload' : 'Browse'}
      </button>

      {label && <span className="truncate font-mono text-[11px] text-slate-500">{label}</span>}
    </div>
  );
}
