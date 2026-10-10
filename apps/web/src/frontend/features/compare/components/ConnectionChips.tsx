/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-line Original / Target chips for the Sync TopBar. Same saved-connection
 * pickers and connect/edit actions as the old stacked cards — compact chrome,
 * not a second connection model.
 */
import React from 'react';
import { CheckCircle2, RefreshCw, Settings } from 'lucide-react';
import { FilterPicker, connectionPickerOption } from '@/shared/components/FilterPicker';
import { dialectLabel } from '@/shared/lib/dialectLabel';

export interface ConnectionChipOption {
  id: string;
  name: string;
  dialect: string;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  username?: string;
}

export interface ConnectionChipProps {
  side: 'source' | 'target';
  label: string;
  connections: readonly ConnectionChipOption[];
  selectedId: string | null | undefined;
  summary: string | null;
  connected: boolean;
  connecting: boolean;
  onSelect: (id: string) => void;
  onEdit: () => void;
  onConnect: () => void;
}

const TONE: Record<
  ConnectionChipProps['side'],
  { ring: string; label: string; summary: string; empty: string }
> = {
  source: {
    ring: 'border-cyan-500/30 bg-cyan-950/20',
    label: 'text-cyan-400',
    summary: 'text-cyan-200',
    empty: 'text-cyan-200/80',
  },
  target: {
    ring: 'border-purple-500/30 bg-purple-950/20',
    label: 'text-purple-400',
    summary: 'text-purple-200',
    empty: 'text-purple-200/80',
  },
};

export function ConnectionChip({
  side,
  label,
  connections,
  selectedId,
  summary,
  connected,
  connecting,
  onSelect,
  onEdit,
  onConnect,
}: ConnectionChipProps): React.ReactElement {
  const tone = TONE[side];
  const savedTestId = side === 'source' ? 'source-saved-select' : 'target-saved-select';
  const editTestId = side === 'source' ? 'source-config-btn' : 'target-config-btn';
  const connectedTestId = side === 'source' ? 'source-connected-btn' : 'target-connected-btn';
  const connectTestId = side === 'source' ? 'source-connect-btn' : 'target-connect-btn';
  const selected = connections.find((c) => c.id === selectedId);
  const pickerSummary = selected
    ? `${selected.name || '(unnamed)'} · ${dialectLabel(selected.dialect)}`
    : '— Saved —';

  return (
    <div
      data-testid={`connection-chip-${side}`}
      // A width floor, not min-w-0. The toolbar is flex-wrap, so a chip that
      // cannot fit its label, picker and buttons should push itself onto the
      // next row rather than collapse to 95px and paint its controls across its
      // neighbours — which is what put the edit button under the "Same DB" pill
      // and made it unclickable.
      //
      // flex-initial, not flex-1: with flex-1 each chip grew to soak up free
      // space, and two of them pushed the rest of the toolbar onto a second
      // line — 87px of chrome for a row that fits in 36. A chip needs a floor
      // and a ceiling, not everything going spare.
      //
      // The ceiling sits close to the floor on purpose. The summary inside
      // truncates, and a connection string is worth less toolbar height than
      // the rest of the toolbar is worth: two chips at 22rem consumed 704px of
      // a 1190px row on a 1280 screen and wrapped everything else.
      className={`flex min-w-[12.5rem] max-w-[16rem] flex-1 items-center gap-1.5 rounded-full border px-2 py-1 ${tone.ring}`}
    >
      <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider ${tone.label}`}>
        {label}
      </span>
      {connections.length > 0 && (
        <FilterPicker
          mode="single"
          testId={savedTestId}
          className="min-w-0 max-w-[12rem] flex-1"
          options={connections.map((c) => ({
            ...connectionPickerOption(c),
            testId: `${savedTestId}-option-${c.id}`,
          }))}
          selectedId={selectedId ?? null}
          onSelect={(id) => {
            if (id) onSelect(id);
          }}
          clearLabel="— Saved —"
          summary={pickerSummary}
          title="Saved connections — search by name, host, database, user, or port"
          placeholder="Search name, host, db, user, port…"
          triggerClassName="flex w-full min-w-0 items-center gap-1 truncate rounded-full border border-slate-700/60 bg-slate-950 px-2 py-0.5 text-left text-[11px] text-slate-200 accent-focus focus:outline-none"
        />
      )}
      <span
        className={`pointer-events-none hidden min-w-0 max-w-[7rem] truncate font-mono text-[10px] font-medium xl:inline ${
          summary ? tone.summary : tone.empty
        }`}
        title={summary ?? undefined}
      >
        {summary ?? 'Add a connection'}
      </span>
      <button
        type="button"
        data-testid={editTestId}
        onClick={onEdit}
        title="Add or edit this connection's credentials"
        className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
      >
        <Settings className="h-3.5 w-3.5" />
        <span className="sr-only">{summary ? 'Edit' : 'Add'} Connection</span>
      </button>
      {connecting ? (
        <span className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${tone.label}`}>
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        </span>
      ) : connected ? (
        <button
          type="button"
          data-testid={connectedTestId}
          onClick={onConnect}
          title="Reconnect and refresh schema list"
          className="group flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-950/40 px-1.5 py-0.5 text-[11px] font-medium text-emerald-400 hover:border-emerald-400/50"
        >
          <CheckCircle2 className="h-3.5 w-3.5 group-hover:hidden" />
          <RefreshCw className="hidden h-3.5 w-3.5 group-hover:block" />
          <span className="group-hover:hidden">On</span>
          <span className="hidden group-hover:inline">Refresh</span>
        </button>
      ) : summary ? (
        // "Connect", not "Retry": most of the time nothing has failed yet —
        // the connection was just picked. And with nothing picked there is
        // nothing to connect to, so the button is not offered at all.
        <button
          type="button"
          data-testid={connectTestId}
          onClick={onConnect}
          title="Connect and load the schema list"
          className="flex shrink-0 items-center gap-1 rounded-full border border-slate-700 px-1.5 py-0.5 text-[11px] font-medium text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Connect
        </button>
      ) : null}
    </div>
  );
}
