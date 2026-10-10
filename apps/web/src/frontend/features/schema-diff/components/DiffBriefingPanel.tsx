/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sync landing after Compare: counts and changed objects already in the
 * compare DTO. Clicking a row selects that object in the tree — no extra query.
 */
import React, { useMemo } from 'react';
import { ArrowRight, Layers } from 'lucide-react';
import type { TableDiff } from '@/shared/lib/types';
import { useSyncStore } from '@/features/compare';
import { diffBriefing } from '../lib/diffBriefing';
import { TYPE_META } from './SchemaDiffTree';

const STATUS_TONE: Record<string, string> = {
  ADDED: 'text-emerald-400',
  REMOVED: 'text-rose-400',
  MODIFIED: 'text-amber-400',
};

export function DiffBriefingPanel(): React.ReactElement {
  const compareResult = useSyncStore((s) => s.compareResult);
  const setSelectedTable = useSyncStore((s) => s.setSelectedTable);
  const syncSelection = useSyncStore((s) => s.syncSelection);
  const filterStatus = useSyncStore((s) => s.filterStatus);
  const setFilterStatus = useSyncStore((s) => s.setFilterStatus);
  const sourceConfig = useSyncStore((s) => s.sourceConfig);
  const targetConfig = useSyncStore((s) => s.targetConfig);

  // `?? []` builds a fresh array whenever there is no compare result, so
  // without this the `changed` memo below re-ran on every render — the exact
  // work it exists to avoid.
  const tables = useMemo(() => compareResult?.tables ?? [], [compareResult]);
  const briefing = diffBriefing(tables);
  const changed = useMemo(
    () => tables.filter((t) => t.status !== 'UNCHANGED'),
    [tables]
  );
  const included = changed.filter((t) => syncSelection[t.tableName]).length;
  const drops = briefing.removed;
  const original = formatEndpoint(sourceConfig);
  const target = formatEndpoint(targetConfig);

  const show = (status: 'ALL' | 'ADDED' | 'REMOVED' | 'MODIFIED') => {
    setFilterStatus(status);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-slate-950/30 p-6"
      data-testid="diff-briefing-panel"
    >
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Diff briefing</p>
      <h2 className="mt-1 text-lg font-bold text-slate-100">What changed</h2>
      <p className="mt-1 max-w-xl text-[12px] text-slate-500">
        <span className="font-mono text-cyan-300/90">{original}</span>
        <ArrowRight className="mx-1 inline h-3 w-3 text-slate-600" />
        <span className="font-mono text-purple-300/90">{target}</span>
      </p>

      <div className="mt-5 grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4">
        <BriefingStat
          testId="diff-briefing-added"
          label="Added"
          count={briefing.added}
          tone="text-emerald-400"
          active={filterStatus === 'ADDED'}
          onClick={() => show('ADDED')}
        />
        <BriefingStat
          testId="diff-briefing-modified"
          label="Modified"
          count={briefing.modified}
          tone="text-amber-400"
          active={filterStatus === 'MODIFIED'}
          onClick={() => show('MODIFIED')}
        />
        <BriefingStat
          testId="diff-briefing-removed"
          label="Removed"
          count={briefing.removed}
          tone="text-rose-400"
          active={filterStatus === 'REMOVED'}
          onClick={() => show('REMOVED')}
        />
        <BriefingStat
          testId="diff-briefing-unchanged"
          label="Unchanged"
          count={briefing.unchanged}
          tone="text-slate-400"
          active={filterStatus === 'ALL'}
          onClick={() => show('ALL')}
        />
      </div>

      <section className="mt-6 max-w-2xl rounded-lg border border-slate-800 bg-slate-950/50 p-4">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
          Deploy checklist
        </h3>
        <ul className="mt-2 space-y-1 text-[12px] text-slate-300">
          <li>
            {included} of {changed.length} changed objects are ticked for the script.
          </li>
          <li className={drops > 0 ? 'text-rose-300' : 'text-slate-500'}>
            {drops > 0
              ? `${drops} object(s) will DROP on Target if included — review before Execute.`
              : 'No removals in this compare.'}
          </li>
          <li className="text-slate-500">
            Pick an object in the list to inspect columns and generated DDL. The tree stays on the
            left.
          </li>
        </ul>
      </section>

      <section className="mt-6 max-w-2xl">
        <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">
          <Layers className="h-3.5 w-3.5" /> Changed objects
        </h3>
        {changed.length === 0 ? (
          <p className="text-[12px] text-slate-500" data-testid="diff-briefing-empty">
            Original and Target match for the current scope.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800 overflow-hidden rounded-lg border border-slate-800">
            {changed.slice(0, 40).map((table) => (
              <ChangedRow key={table.tableName} table={table} onOpen={setSelectedTable} />
            ))}
          </ul>
        )}
        {changed.length > 40 && (
          <p className="mt-2 text-[11px] text-slate-500">
            Showing 40 of {changed.length}. Use the tree to reach the rest.
          </p>
        )}
      </section>
    </div>
  );
}

function ChangedRow({
  table,
  onOpen,
}: {
  table: TableDiff;
  onOpen: (table: TableDiff) => void;
}): React.ReactElement {
  const meta = TYPE_META[table.objectType];
  return (
    <li>
      <button
        type="button"
        data-testid={`diff-briefing-row-${table.tableName}`}
        onClick={() => onOpen(table)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-900"
      >
        <span className={meta?.color}>{meta?.icon}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-slate-100">
          {table.tableName}
        </span>
        <span className={`text-[10px] font-bold uppercase ${STATUS_TONE[table.status] ?? 'text-slate-400'}`}>
          {table.status}
        </span>
      </button>
    </li>
  );
}

function BriefingStat({
  testId,
  label,
  count,
  tone,
  active,
  onClick,
}: {
  testId: string;
  label: string;
  count: number;
  tone: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition ${
        active ? 'border-cyan-500/40 bg-slate-900' : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
      }`}
    >
      <span className={`block text-2xl font-extrabold leading-none ${tone}`}>{count}</span>
      <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
    </button>
  );
}

function formatEndpoint(config: {
  dialect: string;
  schema: string;
  option: { host?: string; database?: string };
}): string {
  const host = config.option.host ?? 'localhost';
  const db = config.option.database ?? '?';
  const schema = config.schema ? ` / ${config.schema}` : '';
  return `${config.dialect} · ${host} / ${db}${schema}`;
}
