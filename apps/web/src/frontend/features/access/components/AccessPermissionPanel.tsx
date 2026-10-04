/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Access → Permission: one session on the cached GRANT catalog.
 *
 * Principal tree + Account | Grants | Effective. Access workspace is
 * generate-only — confirm copies SQL or opens the SQL Editor; it never
 * executes GRANT/REVOKE (Database Access still does).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  describeAllowAll,
  dialectSupportsDbAccess,
  findAllowAll,
  userManagementSupport,
  privilegesForPrincipal,
  type DbPrincipal,
  type DbPrivilege,
} from '@foxschema/sql';
import { fetchDbAccess } from '@/shared/api/schemaApi';
import { useSyncStore } from '@/app/store/useSyncStore';
import { AccessGrantsStage } from './AccessGrantsStage';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { useUiStore } from '@/app/store/uiStore';
import { useAuthStore } from '@/app/store/authStore';
import { EmptyState, Segmented, inputCls, labelCls } from './controls';
import { type DbAccessConfirmRequest } from './DbAccessPermissionSections';
import { PermissionInspector } from './PermissionInspector';
import { SectionLabel } from '@/shared/components/surfaces';
import {
  ALTERATION_LABEL,
  availableAlterations,
  dropSafetyNotes,
} from '../lib/accountAlterations';
import type { AccessPrincipalDraft } from '../lib/access';

type PermissionStage = 'account' | 'grants' | 'effective';
type KindFilter = 'all' | 'user' | 'role';

const KIND_GROUPS: { kind: DbPrincipal['kind']; label: string }[] = [
  { kind: 'user', label: 'Users' },
  { kind: 'role', label: 'Roles' },
  { kind: 'group', label: 'Groups' },
];

export const AccessPermissionPanel: React.FC<{
  initialDraft?: AccessPrincipalDraft | null;
  lockedConnectionId?: string;
  onConnectionChange?: (id: string) => void;
  onAddUser?: () => void;
}> = ({ initialDraft = null, lockedConnectionId, onConnectionChange, onAddUser }) => {
  const connections = useSyncStore((s) => s.connections);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const setSql = useSqlEditorStore((s) => s.setSql);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const canGrant = useAuthStore((s) => s.can('editor.grant'));

  const [localConnectionId, setLocalConnectionId] = useState(initialDraft?.connectionId ?? '');
  const connectionId = lockedConnectionId ?? localConnectionId;
  const pickConnection = (id: string) => {
    onConnectionChange?.(id);
    if (lockedConnectionId === undefined) setLocalConnectionId(id);
  };
  const [principalName, setPrincipalName] = useState(initialDraft?.principalName ?? '');
  const [principals, setPrincipals] = useState<DbPrincipal[]>([]);
  const [privileges, setPrivileges] = useState<DbPrivilege[]>([]);
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DbAccessConfirmRequest | null>(null);
  const [copied, setCopied] = useState(false);
  const [stage, setStage] = useState<PermissionStage>('grants');
  const [filter, setFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [expandedKinds, setExpandedKinds] = useState<Set<DbPrincipal['kind']>>(
    () => new Set(['user', 'role', 'group'])
  );
  const loadToken = useRef(0);

  const conn = connections.find((c) => c.id === connectionId) || null;
  const dialect = conn?.dialect ?? '';
  const support = dialect ? dialectSupportsDbAccess(dialect) : null;

  const selected = useMemo(
    () => principals.find((p) => p.name === principalName) ?? null,
    [principals, principalName]
  );

  const selectedPrivs = useMemo(
    () =>
      selected
        ? privilegesForPrincipal(privileges, selected.name).filter((p) => p.objectType !== 'ROLE')
        : [],
    [privileges, selected]
  );

  useEffect(() => {
    if (!initialDraft) return;
    if (initialDraft.connectionId !== connectionId) {
      ++loadToken.current;
      pickConnection(initialDraft.connectionId);
      setPrincipals([]);
      setPrivileges([]);
      setHint(undefined);
      setError(null);
      setStatus(null);
    }
    setPrincipalName(initialDraft.principalName);
    // Draft identity is the handoff payload, not every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply when User Management hands off
  }, [initialDraft?.connectionId, initialDraft?.principalName]);

  const load = useCallback(async (opts?: { force?: boolean }) => {
    if (!connectionId) return;
    const mine = ++loadToken.current;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const data = await fetchDbAccess(
        { connectionId, password: sessionPasswords[connectionId] || undefined },
        { schema: conn?.schema, force: opts?.force === true }
      );
      if (loadToken.current !== mine) return;
      const next = data.principals ?? [];
      setPrincipals(next);
      setPrivileges(data.privileges ?? []);
      setHint(data.support?.hint);
      setPrincipalName((current) => {
        if (current && next.some((p) => p.name === current)) return current;
        return next[0]?.name ?? '';
      });
    } catch (err: unknown) {
      if (loadToken.current !== mine) return;
      setError(err instanceof Error ? err.message : String(err));
      setPrincipals([]);
      setPrivileges([]);
      setHint(undefined);
    } finally {
      if (loadToken.current === mine) setLoading(false);
    }
  }, [connectionId, sessionPasswords, conn?.schema]);

  useEffect(() => {
    if (!connectionId) {
      setPrincipals([]);
      setPrivileges([]);
      setHint(undefined);
      setPrincipalName('');
      return;
    }
    void load();
    // Load when connection changes; principalName is only used to preserve selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: connection-driven reload
  }, [connectionId]);

  const copyConfirmSql = async () => {
    if (!confirm) return;
    try {
      await navigator.clipboard.writeText(confirm.sql);
      setCopied(true);
      setStatus('Copied to clipboard.');
    } catch {
      setError('Could not copy — select the SQL manually');
    }
  };

  const openInSqlEditor = () => {
    if (!confirm || !connectionId) return;
    setSql?.(confirm.sql);
    ensureConnectionSelected?.(connectionId);
    setActiveView('sqlEditor');
    setStatus('Opened in SQL Editor.');
    setConfirm(null);
  };

  const userCount = useMemo(
    () => principals.filter((p) => p.kind === 'user').length,
    [principals]
  );
  const roleCount = useMemo(
    () => principals.filter((p) => p.kind === 'role' || p.kind === 'group').length,
    [principals]
  );

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return KIND_GROUPS.map((group) => ({
      ...group,
      principals: principals.filter((p) => {
        if (p.kind !== group.kind) return false;
        if (kindFilter === 'user' && p.kind !== 'user') return false;
        if (kindFilter === 'role' && p.kind === 'user') return false;
        if (!needle) return true;
        return (
          p.name.toLowerCase().includes(needle) ||
          p.memberOf.some((m) => m.toLowerCase().includes(needle)) ||
          p.members.some((m) => m.toLowerCase().includes(needle))
        );
      }),
      allOfKind: principals.filter((p) => {
        if (p.kind !== group.kind) return false;
        if (kindFilter === 'user' && p.kind !== 'user') return false;
        if (kindFilter === 'role' && p.kind === 'user') return false;
        return true;
      }),
    })).filter((g) => g.allOfKind.length > 0);
  }, [principals, filter, kindFilter]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="access-permission-panel">
      <div className="shrink-0 px-4 pt-3 pb-2 flex flex-wrap items-center gap-2">
        <label
          className={`flex flex-col gap-1 min-w-[14rem] flex-1 ${
            lockedConnectionId !== undefined ? 'sr-only' : ''
          }`}
        >
          <span className={labelCls}>Database</span>
          <select
            data-testid="access-permission-connection"
            value={connectionId}
            onChange={(e) => {
              if (e.target.value === connectionId) return;
              ++loadToken.current;
              pickConnection(e.target.value);
              setPrincipals([]);
              setPrivileges([]);
              setHint(undefined);
              setPrincipalName('');
              setError(null);
              setStatus(null);
            }}
            className={inputCls}
          >
            <option value="">Choose a saved connection…</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.dialect}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="access-permission-reload"
          disabled={!connectionId || loading}
          onClick={() => void load({ force: true })}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-100 hover:bg-slate-700 disabled:opacity-40"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Reload
        </button>
        {hint && (
          <p className="text-[11px] text-slate-500 w-full" data-testid="access-permission-hint">
            {hint}
          </p>
        )}
      </div>

      {!connectionId && (
        <div className="px-4">
          <EmptyState
            title="Choose a connection"
            body="Pick a saved database to load principals and grant privileges."
            testId="access-permission-needs-connection"
          />
        </div>
      )}

      {connectionId && error && (
        <p className="px-4 text-[11px] text-rose-300" data-testid="access-permission-error">
          {error}
        </p>
      )}
      {connectionId && status && (
        <p className="px-4 text-[11px] text-emerald-300" data-testid="access-permission-status">
          {status}
        </p>
      )}

      {connectionId && (
        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
          <aside
            className="md:w-72 shrink-0 border-t md:border-t-0 md:border-r border-slate-800 flex flex-col min-h-0 bg-slate-950/40"
            data-testid="access-principals-sidebar"
          >
            <div className="px-3 py-2.5 border-b border-slate-800 shrink-0">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Principals
              </p>
              <input
                data-testid="access-permission-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter users & roles"
                className={`${inputCls} mt-2`}
              />
              <div className="mt-2 flex gap-1">
                {(
                  [
                    { id: 'all', label: 'All' },
                    { id: 'user', label: 'Users' },
                    { id: 'role', label: 'Roles' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`access-principals-filter-${opt.id}`}
                    aria-pressed={kindFilter === opt.id}
                    onClick={() => setKindFilter(opt.id)}
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold transition ${
                      kindFilter === opt.id
                        ? 'bg-sky-500/20 text-sky-100 ring-1 ring-sky-500/40'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto" data-testid="access-permission-principal">
              {loading && principals.length === 0 && (
                <p className="px-3 py-2 text-[11px] text-slate-500">Loading…</p>
              )}
              {!loading && principals.length === 0 && (
                <p className="px-3 py-2 text-[11px] text-slate-500">
                  {error ? 'No principals for this connection.' : 'No principals found'}
                </p>
              )}
              {grouped.map((group) => {
                const open = expandedKinds.has(group.kind);
                const Chevron = open ? ChevronDown : ChevronRight;
                return (
                  <section key={group.kind} data-testid={`access-permission-group-${group.kind}`}>
                    <button data-testid={`access-permission-expanded-kinds-${group.kind}`}
                      type="button"
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left bg-slate-950/50"
                      onClick={() =>
                        setExpandedKinds((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.kind)) next.delete(group.kind);
                          else next.add(group.kind);
                          return next;
                        })
                      }
                    >
                      <Chevron className="w-3.5 h-3.5 text-slate-500" />
                      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                        {group.label}
                      </span>
                      <span className="text-[10px] text-slate-600">{group.allOfKind.length}</span>
                    </button>
                    {group.allOfKind.map((p) => {
                      const visible = open && group.principals.some((x) => x.name === p.name);
                      return (
                        <button
                          key={p.name}
                          type="button"
                          hidden={!visible}
                          data-testid={`access-permission-row-${p.name}`}
                          onClick={() => setPrincipalName(p.name)}
                          className={`w-full text-left px-4 py-1.5 text-xs flex items-center gap-2 ${
                            principalName === p.name
                              ? 'bg-sky-500/15 text-sky-50 ring-1 ring-inset ring-sky-500/30'
                              : 'text-slate-200 hover:bg-slate-800/60'
                          }`}
                        >
                          <span className="font-mono truncate">{p.name}</span>
                          <span className="ml-auto shrink-0 rounded border border-slate-700 px-1 py-px text-[9px] font-bold uppercase text-slate-500">
                            {p.kind}
                          </span>
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            </div>
            <div className="shrink-0 border-t border-slate-800 px-3 py-2 flex items-center gap-2">
              {onAddUser && (
                <button
                  type="button"
                  data-testid="access-principals-add-user"
                  onClick={onAddUser}
                  className="inline-flex items-center gap-1 rounded-md border border-cyan-500/40 px-2 py-1 text-[11px] font-bold text-cyan-200 hover:bg-cyan-500/10"
                >
                  <Plus className="w-3 h-3" /> Add user
                </button>
              )}
              <span
                className="ml-auto text-[10px] text-slate-500"
                data-testid="access-principals-counts"
              >
                {userCount} users · {roleCount} roles
              </span>
            </div>
          </aside>

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {selected && (
              <header className="shrink-0 px-4 pt-3 pb-1 border-b border-slate-800/80">
                <div className="flex flex-wrap items-center gap-2">
                  <h2
                    className="text-base font-bold font-mono text-slate-50"
                    data-testid="access-permission-selected-name"
                  >
                    {selected.name}
                  </h2>
                  <span className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-400">
                    {selected.kind}
                  </span>
                  {selected.canLogin === true && (
                    <span className="text-[11px] font-semibold text-emerald-300">● can login</span>
                  )}
                  {selected.canLogin === false && (
                    <span className="text-[11px] font-semibold text-slate-500">● no login</span>
                  )}
                </div>
                <div className="mt-2">
                  <Segmented
                    testId="access-permission-stage"
                    value={stage}
                    onChange={(v) => setStage(v as PermissionStage)}
                    options={[
                      { value: 'account', label: 'Account' },
                      { value: 'grants', label: 'Grants' },
                      { value: 'effective', label: 'Effective' },
                    ]}
                  />
                </div>
              </header>
            )}
            {!selected && (
              <div className="shrink-0 px-4 py-2">
                <Segmented
                  testId="access-permission-stage"
                  value={stage}
                  onChange={(v) => setStage(v as PermissionStage)}
                  options={[
                    { value: 'account', label: 'Account' },
                    { value: 'grants', label: 'Grants' },
                    { value: 'effective', label: 'Effective' },
                  ]}
                />
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 pt-3">
              {error && !selected && (
                <EmptyState
                  title="Catalog unavailable"
                  body={error}
                  testId="access-permission-unsupported"
                />
              )}
              {!error && !selected && (
                <p className="text-[11px] text-slate-500">
                  {loading ? 'Loading principals…' : 'Select a user or role.'}
                </p>
              )}
              {selected && stage === 'account' && (
                <AccountStage
                  principal={selected}
                  principals={principals}
                  privileges={privileges}
                  dialect={dialect}
                  onManageUsers={onAddUser}
                />
              )}
              {selected && stage === 'grants' && (
                <AccessGrantsStage
                  dialect={dialect}
                  connectionId={connectionId}
                  database={conn?.database}
                  defaultSchema={conn?.schema}
                  principal={selected}
                  privileges={selectedPrivs}
                  canGrant={canGrant}
                  grantSupported={Boolean(support?.grant)}
                  onConfirm={(req) => {
                    setCopied(false);
                    setConfirm(req);
                  }}
                  onError={(msg) => setError(msg)}
                />
              )}
              {selected && stage === 'effective' && (
                <PermissionInspector
                  embedded={{
                    connectionId,
                    principalName: selected.name,
                    schema: conn?.schema,
                    principals,
                    privileges,
                    hint,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {confirm &&
        createPortal(
          <div
            className="fixed inset-0 z-[340] flex items-center justify-center bg-black/70 p-4"
            onClick={() => setConfirm(null)}
          >
            <div
              className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              data-testid="access-permission-confirm"
            >
              <h3 className="text-sm font-bold text-slate-100 mb-2">{confirm.title}</h3>
              <p className="text-[11px] text-slate-500 mb-2">
                Access does not execute this SQL. Copy it, or open it in the SQL Editor.
              </p>
              <pre className="text-[11px] font-mono text-slate-300 bg-slate-950 border border-slate-800 rounded px-2 py-2 mb-4 overflow-x-auto whitespace-pre-wrap">
                {confirm.sql}
              </pre>
              <div className="flex flex-wrap justify-end gap-2">
                <button data-testid="access-permission-cancel"
                  type="button"
                  className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="access-permission-open-sql"
                  onClick={openInSqlEditor}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-sky-500/40 bg-sky-500/15 text-sky-100"
                >
                  <FileCode2 className="w-3.5 h-3.5" />
                  Open in SQL Editor
                </button>
                <button
                  type="button"
                  data-testid="access-permission-confirm-run"
                  onClick={() => void copyConfirmSql()}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border ${
                    confirm.kind === 'revoke'
                      ? 'border-rose-500/50 bg-rose-500/20 text-rose-50'
                      : 'border-amber-500/40 bg-amber-500/15 text-amber-100'
                  }`}
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copied ? 'Copied' : 'Copy SQL'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

const AccountStage: React.FC<{
  principal: DbPrincipal;
  /** Every principal, so a role-inherited allow-all can be traced. */
  principals: readonly DbPrincipal[];
  /** The catalog's privileges, so a drop can be described before it is run. */
  privileges: readonly DbPrivilege[];
  dialect: string;
  onManageUsers?: () => void;
}> = ({ principal, principals, privileges, dialect, onManageUsers }) => {
  // Both memoised: this is an unmemoised child of a panel that owns the
  // principal filter, so every keystroke re-ran dropSafetyNotes, which walks
  // the whole privileges array.
  const alterations = useMemo(
    () =>
      availableAlterations(
        userManagementSupport(dialect),
        principal.kind === 'user' ? 'user' : 'role'
      ),
    [dialect, principal.kind]
  );
  const dropNotes = useMemo(
    () => dropSafetyNotes(principal, privileges),
    [principal, privileges]
  );
  const allowAll = useMemo(
    () => findAllowAll({ principal: principal.name, principals, privileges, dialect }),
    [principal.name, principals, privileges, dialect]
  );
  const login =
    principal.canLogin === true
      ? 'Can log in'
      : principal.canLogin === false
        ? 'Cannot log in'
        : 'Login unknown';
  return (
    <div className="space-y-3" data-testid="access-permission-account">
      <p className="text-[11px] text-slate-500">
        Account details from the GRANT catalog. Add, rename, or drop accounts under User
        Management — Access generates SQL only.
      </p>
      {allowAll && (
        <p
          data-testid="access-permission-allow-all"
          className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-rose-200"
        >
          {describeAllowAll(allowAll)}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
        <dt className="text-slate-500">Name</dt>
        <dd className="font-mono text-slate-100" data-testid="access-permission-account-name">
          {principal.name}
        </dd>
        <dt className="text-slate-500">Kind</dt>
        <dd className="text-slate-200 capitalize" data-testid="access-permission-account-kind">
          {principal.kind}
        </dd>
        <dt className="text-slate-500">Login</dt>
        <dd className="text-slate-200" data-testid="access-permission-account-login">
          {login}
        </dd>
      </dl>
      {/* What this engine can change about this principal. Naming them here
          means the reader learns what is possible without opening the form and
          finding out by absence. */}
      <div data-testid="access-permission-account-alterations">
        <SectionLabel className="mb-1">Alteration</SectionLabel>
        {alterations.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            This engine has no edit actions for this kind of account.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {alterations.map((a) => (
              <li
                key={a}
                data-testid={`access-permission-alteration-${a}`}
                className="rounded-md border border-slate-700 px-2 py-0.5 text-[11px] font-semibold text-slate-300"
              >
                {ALTERATION_LABEL[a]}
              </li>
            ))}
          </ul>
        )}
      </div>

      {dropNotes.length > 0 && (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2"
          data-testid="access-permission-drop-safety"
        >
          <SectionLabel className="mb-1">Drop safety notes</SectionLabel>
          <ul className="space-y-1 text-[11px] text-amber-100/90">
            {dropNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {onManageUsers && (
        <button
          type="button"
          data-testid="access-permission-open-user-management"
          onClick={onManageUsers}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-600 px-2.5 py-1.5 text-[11px] font-bold text-slate-200 hover:bg-slate-800"
        >
          Open User Management
        </button>
      )}
      <div>
        <SectionLabel className="mb-1">
          Member of
        </SectionLabel>
        {principal.memberOf.length === 0 ? (
          <p className="text-[11px] text-slate-500">Not a member of any role.</p>
        ) : (
          <ul className="flex flex-wrap gap-1" data-testid="access-permission-account-memberof">
            {principal.memberOf.map((name) => (
              <li
                key={name}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-slate-200"
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <SectionLabel className="mb-1">
          Members
        </SectionLabel>
        {principal.members.length === 0 ? (
          <p className="text-[11px] text-slate-500">No members.</p>
        ) : (
          <ul className="flex flex-wrap gap-1" data-testid="access-permission-account-members">
            {principal.members.map((name) => (
              <li
                key={name}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-slate-200"
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
