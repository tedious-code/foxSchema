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
  AlertTriangle,
  Cpu,
  Database,
  HardDrive,
  HeartPulse,
  Loader2,
  Network,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  buildSessionControlSql,
  buildTableMaintenanceSql,
  dialectSupportsDbaUtility,
  dialectSupportsSessionLocks,
  dialectSupportsTableMaintenance,
  formatBytes,
  formatPct,
  formatRowCount,
  type DbaUtilityKind,
  type SessionControlAction,
  type TableMaintenanceAction,
} from '@foxschema/ui-shared';
import {
  fetchDbaUtility,
  fetchSessionLocks,
  fetchTableHealth,
  runSessionControl,
  runTableMaintenance,
  type DbaUtilityResponse,
  type SessionLocksResponse,
  type TableHealthResponse,
} from '@/shared/api/schemaApi';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useAuthStore } from '@/platform/authStore';
import { PROVIDER_SETTINGS, needsSessionPassword } from '@/shared/lib/provider-settings';
import { IndexManagementModal } from './IndexManagementModal';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { connectionOptionLabel } from '@/shared/lib/dialectLabel';

export type ServerInsightsTab = DbaUtilityKind | 'health';

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
  { id: 'health', label: 'Table Health', icon: <HeartPulse className="w-3.5 h-3.5" /> },
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
  // Cancel / kill and table maintenance change the server, so they need more
  // than utility.access; the server enforces the same permission.
  const canControl = useAuthStore((s) => s.can('utility.dba.control'));

  const [connectionId, setConnectionId] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [tab, setTab] = useState<ServerInsightsTab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DbaUtilityResponse | null>(null);
  const [locksData, setLocksData] = useState<SessionLocksResponse | null>(null);
  const [healthData, setHealthData] = useState<TableHealthResponse | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    kind: 'session' | 'table';
    sql: string;
    description: string;
    sessionAction?: SessionControlAction;
    sessionId?: string;
    tableAction?: TableMaintenanceAction;
    schema?: string;
    table?: string;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

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
    setLocksData(null);
    setHealthData(null);
    setPendingAction(null);
    setActionNotice(null);
    setPasswordDraft('');
  }, [open, connections, initialTab, lockedConnectionId]);

  const conn = connections.find((c) => c.id === connectionId) || null;
  // File dialects carry no password; asking for one blocked the utility outright.
  const needsPassword = Boolean(
    conn && needsSessionPassword(conn, sessionPasswords[connectionId])
  );
  const lockSupport = useMemo(
    () => dialectSupportsSessionLocks(conn?.dialect || ''),
    [conn?.dialect],
  );
  const showSessionControls =
    canControl && (lockSupport.canCancelQuery || lockSupport.canTerminateSession);
  const healthSupport = useMemo(
    () => dialectSupportsTableMaintenance(conn?.dialect || ''),
    [conn?.dialect],
  );
  const support = useMemo(() => {
    if (tab === 'health') {
      return {
        mode: healthSupport.canInspectHealth ? ('native' as const) : ('unsupported' as const),
        query: healthSupport.canInspectHealth,
        hint: healthSupport.hint,
      };
    }
    return dialectSupportsDbaUtility(conn?.dialect || '', tab);
  }, [conn?.dialect, tab, healthSupport]);

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
    setActionNotice(null);
    try {
      await ensureConnectionSelected(connectionId);
      localStorage.setItem(LS_CONN, connectionId);
      const password = sessionPasswords[connectionId];
      if (tab === 'health') {
        const result = await fetchTableHealth({ connectionId, password }, { schema: conn.schema });
        setHealthData(result);
        setData(null);
        setLocksData(null);
      } else {
        const result = await fetchDbaUtility(
          { connectionId, password },
          { kind: tab, schema: conn.schema }
        );
        setData(result);
        setHealthData(null);
        if (tab === 'sessions' && lockSupport.supported) {
          try {
            const locks = await fetchSessionLocks({ connectionId, password }, { schema: conn.schema });
            setLocksData(locks);
          } catch {
            setLocksData(null);
          }
        } else {
          setLocksData(null);
        }
      }
    } catch (err) {
      setData(null);
      setLocksData(null);
      setHealthData(null);
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
    lockSupport.supported,
  ]);

  const queueSessionAction = (action: SessionControlAction, sessionId: string) => {
    if (!conn) return;
    const built = buildSessionControlSql(conn.dialect, action, sessionId);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setPendingAction({
      kind: 'session',
      sql: built.sql,
      description: built.description,
      sessionAction: action,
      sessionId,
    });
  };

  const queueTableAction = (action: TableMaintenanceAction, schema: string | null, table: string) => {
    if (!conn) return;
    // Build with the schema the server will use, so the SQL shown for
    // confirmation is the SQL that runs.
    const effectiveSchema = schema || conn.schema || undefined;
    const built = buildTableMaintenanceSql(conn.dialect, action, { schema: effectiveSchema, table });
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setPendingAction({
      kind: 'table',
      sql: built.sql,
      description: built.description,
      tableAction: action,
      schema: effectiveSchema,
      table,
    });
  };

  const confirmPendingAction = async () => {
    if (!pendingAction || !connectionId || !conn) return;
    setActionBusy(true);
    setError(null);
    try {
      const password = sessionPasswords[connectionId];
      if (pendingAction.kind === 'session' && pendingAction.sessionAction && pendingAction.sessionId) {
        const res = await runSessionControl(
          { connectionId, password },
          { action: pendingAction.sessionAction, sessionId: pendingAction.sessionId },
        );
        setActionNotice(res.description);
      } else if (pendingAction.kind === 'table' && pendingAction.tableAction && pendingAction.table) {
        const res = await runTableMaintenance(
          { connectionId, password },
          {
            action: pendingAction.tableAction,
            schema: pendingAction.schema,
            table: pendingAction.table,
          },
        );
        setActionNotice(res.description);
      }
      setPendingAction(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionBusy(false);
    }
  };

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

          {pendingAction && (
            <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-100">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-bold">
                  <ShieldAlert className="h-4 w-4 text-amber-300" />
                  <span>{pendingAction.description}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="server-insights-cancel-action"
                    disabled={actionBusy}
                    onClick={() => setPendingAction(null)}
                    className="rounded border border-slate-600 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="server-insights-confirm-action"
                    disabled={actionBusy}
                    onClick={() => void confirmPendingAction()}
                    className="rounded border border-rose-500/50 bg-rose-500/20 px-2.5 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/30 disabled:opacity-50"
                  >
                    {actionBusy ? 'Running…' : 'Execute SQL'}
                  </button>
                </div>
              </div>
              <pre className="mt-2 overflow-x-auto rounded bg-slate-950/70 px-2.5 py-1.5 font-mono text-[11px] text-amber-200">
                {pendingAction.sql}
              </pre>
            </div>
          )}
          {actionNotice && (
            <div className="mb-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200">
              {actionNotice}
            </div>
          )}
          {!loading && data?.kind === 'sessions' && (
            <div className="space-y-3">
              {locksData && locksData.chains.length > 0 && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3">
                  <div className="mb-2 flex items-center gap-2 text-[12px] font-bold text-rose-200">
                    <AlertTriangle className="h-4 w-4 text-rose-400" />
                    <span>Blocking Lock Chains ({locksData.chains.length})</span>
                  </div>
                  <div className="space-y-2">
                    {locksData.chains.map((chain) => (
                      <div
                        key={chain.rootBlockerSessionId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-rose-500/30 bg-slate-950/60 px-3 py-2 text-[12px]"
                      >
                        <div className="min-w-0">
                          <span className="font-mono font-bold text-rose-200">
                            Blocker #{chain.rootBlockerSessionId}
                          </span>
                          {chain.blockerUser && (
                            <span className="ml-2 text-slate-300">({chain.blockerUser})</span>
                          )}
                          <span className="ml-2 text-amber-300">
                            blocking {chain.blockedCount} session{chain.blockedCount === 1 ? '' : 's'}
                            {chain.maxWaitSeconds != null ? ` · max wait ${chain.maxWaitSeconds}s` : ''}
                          </span>
                          {chain.blockerQuery && (
                            <div className="mt-0.5 max-w-xl truncate font-mono text-[11px] text-slate-400">
                              {chain.blockerQuery}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {canControl && lockSupport.canCancelQuery && (
                            <button
                              type="button"
                              data-testid={`server-insights-blocker-cancel-${chain.rootBlockerSessionId}`}
                              onClick={() => queueSessionAction('cancel', chain.rootBlockerSessionId)}
                              className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] font-bold text-amber-100 hover:bg-amber-500/25"
                            >
                              Cancel Query
                            </button>
                          )}
                          {canControl && lockSupport.canTerminateSession && (
                            <button
                              type="button"
                              data-testid={`server-insights-blocker-kill-${chain.rootBlockerSessionId}`}
                              onClick={() => queueSessionAction('terminate', chain.rootBlockerSessionId)}
                              className="rounded border border-rose-500/40 bg-rose-500/20 px-2 py-1 text-[11px] font-bold text-rose-100 hover:bg-rose-500/30"
                            >
                              Kill Session
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
                      {showSessionControls && <th className="px-3 py-2 font-bold text-right">Control</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(data.sessions ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={showSessionControls ? 7 : 6} className="px-3 py-6 text-center text-slate-500">
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
                          {showSessionControls && (
                            <td className="px-3 py-1.5 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1">
                                {canControl && lockSupport.canCancelQuery && (
                                  <button
                                    type="button"
                                    data-testid={`server-insights-session-cancel-${s.sessionId}`}
                                    onClick={() => queueSessionAction('cancel', s.sessionId)}
                                    className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/15"
                                  >
                                    Cancel
                                  </button>
                                )}
                                {canControl && lockSupport.canTerminateSession && (
                                  <button
                                    type="button"
                                    data-testid={`server-insights-session-kill-${s.sessionId}`}
                                    onClick={() => queueSessionAction('terminate', s.sessionId)}
                                    className="rounded border border-rose-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-rose-200 hover:bg-rose-500/15"
                                  >
                                    Kill
                                  </button>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && tab === 'health' && healthData && (
            <div className="overflow-auto rounded-lg border border-slate-700">
              <table className="min-w-full text-left text-[12px]">
                <thead className="bg-slate-950/60 text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-bold">Table</th>
                    <th className="px-3 py-2 font-bold text-right">Live rows</th>
                    <th className="px-3 py-2 font-bold text-right">Dead / Mods</th>
                    <th className="px-3 py-2 font-bold text-right">Bloat</th>
                    <th className="px-3 py-2 font-bold">Last Analyzed</th>
                    <th className="px-3 py-2 font-bold text-right">Maintenance</th>
                  </tr>
                </thead>
                <tbody>
                  {healthData.tables.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                        No tables returned.
                      </td>
                    </tr>
                  ) : (
                    healthData.tables.map((row) => (
                      <tr key={`${row.schemaName ?? ''}.${row.tableName}`} className="border-t border-slate-800">
                        <td className="px-3 py-1.5 font-mono text-slate-100">
                          {row.schemaName ? `${row.schemaName}.${row.tableName}` : row.tableName}
                          {row.staleStats && (
                            <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200">
                              STALE STATS
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-200">
                          {formatRowCount(row.liveRows)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-300">
                          {row.deadRows != null
                            ? `${formatRowCount(row.deadRows)}${row.deadRatioPct != null ? ` (${row.deadRatioPct}%)` : ''}`
                            : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-300">
                          {formatBytes(row.bloatBytes)}
                        </td>
                        <td className="px-3 py-1.5 text-slate-400">{row.lastAnalyzed || '—'}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            {canControl && healthSupport.canAnalyze && (
                              <button
                                type="button"
                                data-testid={`server-insights-health-analyze-${row.tableName}`}
                                onClick={() => queueTableAction('analyze', row.schemaName, row.tableName)}
                                className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-bold text-sky-100 hover:bg-sky-500/25"
                              >
                                <Sparkles className="h-3 w-3" /> Analyze
                              </button>
                            )}
                            {canControl && healthSupport.canVacuum && (
                              <button
                                type="button"
                                data-testid={`server-insights-health-vacuum-${row.tableName}`}
                                onClick={() => queueTableAction('vacuum', row.schemaName, row.tableName)}
                                className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-100 hover:bg-amber-500/25"
                              >
                                Vacuum
                              </button>
                            )}
                            {canControl && healthSupport.canOptimize && (
                              <button
                                type="button"
                                data-testid={`server-insights-health-optimize-${row.tableName}`}
                                onClick={() => queueTableAction('optimize', row.schemaName, row.tableName)}
                                className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-100 hover:bg-amber-500/25"
                              >
                                Optimize
                              </button>
                            )}
                          </div>
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
