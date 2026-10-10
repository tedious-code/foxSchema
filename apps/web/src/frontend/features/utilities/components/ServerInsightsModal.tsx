/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Utilities → Server Insights: connection pool, user sessions, system info
 * (RAM / storage / CPU), and table/index sizes.
 *
 * Uses remappable slate-* tokens (uiStore data-theme) so dark + light modes
 * both keep readable contrast — same pattern as Index Management / Clone Table.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Cpu,
  Database,
  HardDrive,
  Loader2,
  Network,
  RefreshCw,
  Users,
  X,
} from 'lucide-react';
import { dialectSupportsDbaUtility, formatBytes, formatPct, type DbaUtilityKind } from '@foxschema/ui-shared';
import { fetchDbaUtility, type DbaUtilityResponse } from '@/shared/api/schemaApi';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { PROVIDER_SETTINGS, connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { IndexManagementModal } from './IndexManagementModal';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { connectionOptionLabel } from '@/shared/lib/dialectLabel';

export type ServerInsightsTab = DbaUtilityKind;

interface Props {
  open: boolean;
  initialTab?: ServerInsightsTab;
  onClose?: () => void;
  /** Dock in the Utilities workspace (no overlay). */
  embedded?: boolean;
  /** Workspace credential — hides this form's picker. */
  lockedConnectionId?: string;
}

const LS_CONN = 'foxschema-utilities-server-insights-connection';

const TABS: Array<{ id: ServerInsightsTab; label: string; icon: React.ReactNode }> = [
  { id: 'pool', label: 'Connection Pool', icon: <Network className="w-3.5 h-3.5" /> },
  { id: 'sessions', label: 'User Connections', icon: <Users className="w-3.5 h-3.5" /> },
  { id: 'system', label: 'System Info', icon: <Cpu className="w-3.5 h-3.5" /> },
  { id: 'sizes', label: 'Table & Index Size', icon: <HardDrive className="w-3.5 h-3.5" /> },
];

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2.5">
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-[15px] font-bold text-slate-100 tabular-nums">{value}</div>
    </div>
  );
}

function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Utilities modal: credential → tabbed DBA probes. */
export const ServerInsightsModal: React.FC<Props> = ({
  open,
  initialTab = 'pool',
  onClose,
  embedded = false,
  lockedConnectionId,
}) => {
  const connections = useSyncStore((s) => s.connections);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const submitSessionPassword = useSqlEditorStore((s) => s.submitSessionPassword);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);

  const [connectionId, setConnectionId] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [tab, setTab] = useState<ServerInsightsTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DbaUtilityResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    const saved = localStorage.getItem(LS_CONN) || '';
    const fallback = connections[0]?.id || '';
    const next = lockedConnectionId
      ? lockedConnectionId
      : connections.some((c) => c.id === saved)
        ? saved
        : fallback;
    setConnectionId(next);
    setTab(initialTab);
    setError(null);
    setData(null);
    setPasswordDraft('');
  }, [open, connections, initialTab, lockedConnectionId]);

  const conn = connections.find((c) => c.id === connectionId) || null;
  // File dialects carry no password; asking for one blocked the utility outright.
  const needsPassword = Boolean(
    conn && !conn.hasPassword && connectionNeedsSecret(conn.dialect, conn.authMethod) && !sessionPasswords[connectionId]
  );
  const support = useMemo(
    () => dialectSupportsDbaUtility(conn?.dialect || '', tab),
    [conn?.dialect, tab]
  );

  const load = useCallback(async () => {
    if (!connectionId || !conn) {
      setError('Select a connection.');
      return;
    }
    if (needsPassword) {
      setError('Unlock the connection password first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await ensureConnectionSelected(connectionId);
      localStorage.setItem(LS_CONN, connectionId);
      const password = sessionPasswords[connectionId];
      const result = await fetchDbaUtility(
        { connectionId, password },
        { kind: tab, schema: conn.schema }
      );
      setData(result);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Failed to load utility data');
    } finally {
      setLoading(false);
    }
  }, [
    connectionId,
    conn,
    needsPassword,
    ensureConnectionSelected,
    sessionPasswords,
    tab,
  ]);

  useEffect(() => {
    if (!open || !connectionId || needsPassword || tab === 'sizes') return;
    if (!support.query) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is omitted on purpose: tab/connection changes already re-trigger, and `load` is rebuilt on every render
  }, [open, connectionId, tab, needsPassword, support.query]);

  const unlock = () => {
    if (!connectionId || !passwordDraft.trim()) return;
    ensureConnectionSelected(connectionId);
    submitSessionPassword(passwordDraft.trim());
    setPasswordDraft('');
    setError(null);
  };

  if (!open) return null;

  const panel = (
      <div
        className={
          embedded
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-900'
            : 'flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl'
        }
        onMouseDown={(e) => e.stopPropagation()}
      >
        {!embedded && (
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/50 px-5 py-3.5 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Activity className="h-4 w-4 text-amber-400 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-100">Server Insights</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Connection pool, sessions, system resources, and Index Management
              </p>
            </div>
          </div>
          <button data-testid="server-insights-close"
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        )}

        <div className="flex flex-wrap items-end gap-2 border-b border-slate-800 bg-slate-950/30 px-5 py-3 shrink-0">
          {!lockedConnectionId && (
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
            <span className={sectionLabelCls}>
              Credential
            </span>
            <select
              data-testid="server-insights-connection"
              value={connectionId}
              onChange={(e) => {
                const id = e.target.value;
                setConnectionId(id);
                if (id) localStorage.setItem(LS_CONN, id);
              }}
              className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus"
            >
              {connections.length === 0 ? (
                <option value="">No connections</option>
              ) : (
                connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {connectionOptionLabel(c)}
                  </option>
                ))
              )}
            </select>
          </label>
          )}
          {needsPassword && (
            <label className="flex flex-col gap-1 min-w-[10rem]">
              <span className={sectionLabelCls}>
                Session password
              </span>
              <div className="flex gap-1">
                <input data-testid="server-insights-password-draft"
                  type="password"
                  value={passwordDraft}
                  onChange={(e) => setPasswordDraft(e.target.value)}
                  placeholder="••••••••"
                  className="bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 outline-none accent-focus font-mono w-36"
                />
                <button data-testid="server-insights-unlock"
                  type="button"
                  onClick={() => unlock()}
                  className="px-2.5 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-100"
                >
                  Unlock
                </button>
              </div>
            </label>
          )}
          <button
            type="button"
            data-testid="server-insights-refresh"
            disabled={loading || !connectionId || needsPassword || !support.query || tab === 'sizes'}
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-slate-800 bg-slate-950/20 px-3 pt-2 shrink-0">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`server-insights-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[12px] font-bold ${
                  active
                    ? 'border border-b-0 border-slate-700 bg-slate-900 text-amber-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 flex flex-col overflow-hidden">
          {tab === 'sizes' ? (
            <>
              <p className="shrink-0 px-5 pt-3 pb-1 text-[12px] text-slate-400">
                Same Index Management grid — expand tables, sort columns, see sizes and
                average fragmentation, and defragment indexes.
              </p>
              <IndexManagementModal
                open={open}
                embedded
                lockedConnectionId={connectionId}
              />
            </>
          ) : (
          <div className="px-5 py-3 min-h-0 flex-1 overflow-auto">
          <p className="mb-3 text-[12px] text-slate-400">{support.hint}</p>
          {error && (
            <div className="mb-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
              {error}
            </div>
          )}
          {!support.query && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-100">
              This dialect does not expose a built-in probe for this view.
            </div>
          )}
          {loading && (
            <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin text-amber-400" /> Loading…
            </div>
          )}

          {!loading && data?.kind === 'pool' && data.pool && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                <MetricCard label="Max" value={data.pool.maxConnections?.toLocaleString() ?? '—'} />
                <MetricCard label="Current" value={data.pool.currentConnections?.toLocaleString() ?? '—'} />
                <MetricCard label="Active" value={data.pool.activeConnections?.toLocaleString() ?? '—'} />
                <MetricCard label="Available" value={data.pool.availableConnections?.toLocaleString() ?? '—'} />
                <MetricCard label="Waiting" value={data.pool.waitCount?.toLocaleString() ?? '—'} />
              </div>
              {data.pool.details.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-slate-700">
                  <table className="w-full text-left text-[12px]">
                    <tbody>
                      {data.pool.details.map((d) => (
                        <tr key={d.key} className="border-t border-slate-800">
                          <td className="px-3 py-1.5 font-semibold text-slate-500">{d.key}</td>
                          <td className="px-3 py-1.5 font-mono text-slate-100">{d.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {!loading && data?.kind === 'sessions' && (
            <div className="overflow-auto rounded-lg border border-slate-700">
              <table className="min-w-full text-left text-[12px]">
                <thead className="bg-slate-950/60 text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-bold">Session</th>
                    <th className="px-3 py-2 font-bold">User</th>
                    <th className="px-3 py-2 font-bold">Host</th>
                    <th className="px-3 py-2 font-bold">DB</th>
                    <th className="px-3 py-2 font-bold">State</th>
                    <th className="px-3 py-2 font-bold">Query</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.sessions ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                        No sessions returned.
                      </td>
                    </tr>
                  ) : (
                    (data.sessions ?? []).map((s) => (
                      <tr key={s.sessionId} className="border-t border-slate-800 align-top">
                        <td className="px-3 py-1.5 font-mono text-slate-200">{s.sessionId}</td>
                        <td className="px-3 py-1.5 font-semibold text-slate-100">{s.userName || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-400">{s.clientHost || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-400">{s.databaseName || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-300">{s.state || '—'}</td>
                        <td
                          className="max-w-[280px] truncate px-3 py-1.5 font-mono text-slate-400"
                          title={s.queryText || ''}
                        >
                          {s.queryText || '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {!loading && data?.kind === 'system' && data.system && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <MetricCard label="CPU cores" value={data.system.cpuCount?.toLocaleString() ?? '—'} />
                <MetricCard label="CPU usage" value={formatPct(data.system.cpuUsagePercent)} />
                <MetricCard label="RAM total" value={formatBytes(data.system.memoryTotalBytes)} />
                <MetricCard label="RAM used" value={formatBytes(data.system.memoryUsedBytes)} />
                <MetricCard label="RAM available" value={formatBytes(data.system.memoryAvailableBytes)} />
                <MetricCard label="DB storage used" value={formatBytes(data.system.storageUsedBytes)} />
                <MetricCard label="Uptime" value={formatUptime(data.system.uptimeSeconds)} />
                <MetricCard
                  label="Version"
                  value={
                    data.system.serverVersion
                      ? data.system.serverVersion.length > 28
                        ? `${data.system.serverVersion.slice(0, 28)}…`
                        : data.system.serverVersion
                      : '—'
                  }
                />
              </div>
              {data.system.serverVersion && (
                <p className="break-all text-[12px] text-slate-400">{data.system.serverVersion}</p>
              )}
            </div>
          )}

          {!loading && !error && support.query && !data && (
            <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-500">
              <Database className="h-4 w-4 text-amber-400" /> Select a connection and refresh.
            </div>
          )}
          </div>
          )}
        </div>
      </div>
  );

  if (embedded) {
    return (
      <div
        data-testid="server-insights-modal"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {panel}
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      data-testid="server-insights-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      {panel}
    </div>,
    document.body
  );
};
