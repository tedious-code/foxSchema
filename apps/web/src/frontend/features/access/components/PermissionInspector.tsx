import React, { useMemo, useRef, useState } from 'react';
import { RefreshCw, ArrowDown, ShieldX, Check, X, AlertTriangle, Info } from 'lucide-react';
import { fetchDbAccess } from '@/shared/api/schemaApi';
import { Autocomplete } from '@/shared/components/Autocomplete';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import {
  describePermission,
  resolveEffectiveAccess,
  type AccessPermission,
  type AccessSource,
  type EffectiveAccess,
  type EffectiveObject,
} from '../lib/access';
import type { DbPrincipal, DbPrivilege } from '@foxschema/ui-shared';
import { inputCls, labelCls } from '@/shared/components/controls';
import { connectionOptionLabel } from '@/shared/lib/dialectLabel';

/** The columns the effective-permission table reports on, in reading order. */
const TABLE_PERMISSIONS: AccessPermission[] = ['read', 'insert', 'update', 'delete'];

/**
 * Reads the grants that already exist and explains where each one comes from.
 *
 * The database can already list raw grants. What it cannot answer is "why does
 * this user have access?" — direct grant, a role, a role's role, or a DENY that
 * overrides all of them. That resolution is the feature.
 */
export const PermissionInspector: React.FC<{
  /**
   * Drive the inspector from another panel's selections.
   *
   * Given these it hides its own pickers and reads for what that panel already
   * knows — which is what lets the builder show, in one window, both what a
   * principal has now and what the reader is about to grant it.
   *
   * When `principals` and `privileges` are passed, the inspector uses that
   * catalog and does not fetch again (Access Permission already loaded it).
   */
  embedded?: {
    connectionId: string;
    principalName: string;
    schema?: string;
    principals?: DbPrincipal[];
    privileges?: DbPrivilege[];
    hint?: string;
  };
}> = ({ embedded }) => {
  const connections = useSyncStore((s) => s.connections);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const [connectionId, setConnectionId] = useState('');
  const [schema, setSchema] = useState('');
  const [principalName, setPrincipalName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    principals: DbPrincipal[];
    privileges: DbPrivilege[];
    hint?: string;
  } | null>(null);
  const loadToken = useRef(0);

  const conn = connections.find((c) => c.id === connectionId) || null;

  // Follow the host panel. Its connection and principal are the subject, so a
  // change there re-reads rather than leaving a stale answer under a new name.
  const embeddedConnection = embedded?.connectionId;
  const embeddedPrincipal = embedded?.principalName;
  const embeddedSchema = embedded?.schema;
  const catalogPrincipals = embedded?.principals;
  const catalogPrivileges = embedded?.privileges;
  const catalogHint = embedded?.hint;
  const hasCatalog = catalogPrincipals != null && catalogPrivileges != null;
  React.useEffect(() => {
    if (embeddedConnection === undefined) return;
    loadToken.current++;
    setConnectionId(embeddedConnection);
    setSchema(embeddedSchema ?? '');
    if (!hasCatalog) {
      setData(null);
    }
    setError(null);
    setLoading(false);
  }, [embeddedConnection, embeddedSchema, hasCatalog]);
  React.useEffect(() => {
    if (embeddedPrincipal === undefined) return;
    setPrincipalName(embeddedPrincipal);
  }, [embeddedPrincipal]);
  React.useEffect(() => {
    if (!hasCatalog) return;
    setData({
      principals: catalogPrincipals,
      privileges: catalogPrivileges,
      hint: catalogHint,
    });
    setError(null);
    setLoading(false);
  }, [hasCatalog, catalogPrincipals, catalogPrivileges, catalogHint]);

  const load = async () => {
    if (!connectionId) return;
    const token = ++loadToken.current;
    const superseded = () => loadToken.current !== token;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDbAccess(
        { connectionId, password: sessionPasswords[connectionId] || undefined },
        { schema: schema || undefined }
      );
      if (superseded()) return;
      setData({
        principals: res.principals ?? [],
        privileges: res.privileges ?? [],
        hint: res.support?.hint,
      });
      if (!principalName && res.principals?.length) setPrincipalName(res.principals[0].name);
    } catch (e: unknown) {
      if (superseded()) return;
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      if (!superseded()) setLoading(false);
    }
  };

  const effective: EffectiveAccess | null = useMemo(() => {
    if (!data || !principalName) return null;
    return resolveEffectiveAccess({
      principal: principalName,
      principals: data.principals,
      privileges: data.privileges,
      schema: schema || undefined,
    });
  }, [data, principalName, schema]);

  return (
    <div
      className={`flex-1 flex flex-col min-h-0 overflow-y-auto ${embedded ? 'p-0 gap-3' : 'p-5 gap-4'}`}
      data-testid="permission-inspector"
    >
      {!embedded && (
        <div>
          <h2 className="text-sm font-bold text-slate-100">Permission Inspector</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            The effective permissions for a user or role, including what they inherit — and where
            each one comes from.
          </p>
        </div>
      )}

      {!hasCatalog && (
        <div className="shrink-0 flex flex-wrap items-end gap-2">
          <label className={`flex flex-col gap-1 min-w-[16rem] flex-1 ${embedded ? 'hidden' : ''}`}>
            <span className={labelCls}>Database</span>
            <select
              data-testid="inspector-connection"
              value={connectionId}
              onChange={(e) => {
                loadToken.current++;
                setConnectionId(e.target.value);
                setData(null);
                setPrincipalName('');
                setError(null);
                setLoading(false);
              }}
              className={inputCls}
            >
              <option value="">Choose a saved connection…</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {connectionOptionLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className={`flex flex-col gap-1 w-40 ${embedded ? 'hidden' : ''}`}>
            <span className={labelCls}>Schema</span>
            <input
              data-testid="inspector-schema"
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              placeholder={conn?.schema || 'all schemas'}
              className={`${inputCls} font-mono`}
            />
          </label>
          <button
            type="button"
            data-testid="inspector-load"
            onClick={load}
            disabled={!connectionId || loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-sky-500/40 bg-sky-500/15 text-xs font-bold text-sky-100 disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Reading…' : 'Read permissions'}
          </button>
        </div>
      )}

      {error && (
        <div
          data-testid="inspector-error"
          className="rounded-md border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200"
        >
          {error}
        </div>
      )}

      {!data && !error && !hasCatalog && (
        <p className="text-[11px] text-slate-500">
          Choose a connection and read its permissions. Fox Schema only reads — it changes nothing.
        </p>
      )}

      {data && !hasCatalog && (
        <label className="flex flex-col gap-1 max-w-md">
          <span className={labelCls}>User or role</span>
          <Autocomplete
            data-testid="inspector-principal"
            theme="slate"
            value={principalName}
            onChange={setPrincipalName}
            options={data.principals.map((p) => ({ value: p.name, hint: p.kind }))}
            placeholder="Pick a user or role"
            className={`${inputCls} font-mono`}
          />
        </label>
      )}

      {effective && (
        <>
          <section className="shrink-0 rounded-md border border-slate-800 p-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
              Permissions summary
            </h3>
            <div className="mt-2 flex flex-wrap gap-2" data-testid="inspector-summary">
              {(['connect', ...TABLE_PERMISSIONS] as AccessPermission[]).map((p) => {
                const slot = effective.summary.find((s) => s.permission === p);
                const on = slot?.granted === true;
                return (
                  <div
                    key={p}
                    data-testid={`inspector-summary-${p}`}
                    className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold ${
                      on
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                        : 'border-slate-700 bg-slate-900/40 text-slate-500'
                    }`}
                  >
                    {on ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                    {describePermission(p).label}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Why: the chain from the principal to whatever confers the access. */}
          {effective.inheritedRoles.length > 0 && (
            <section className="shrink-0 rounded-md border border-slate-800 p-3" data-testid="inspector-chain">
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Why does this principal have access?
              </h3>
              <div className="mt-2 flex flex-col gap-1">
                <Node label={effective.principal} sub="Principal" />
                {effective.inheritedRoles.map((r) => (
                  <React.Fragment key={r}>
                    <ArrowDown className="w-3 h-3 text-slate-600 ml-3" />
                    <Node label={r} sub="Role" />
                  </React.Fragment>
                ))}
              </div>
            </section>
          )}

          <section className="shrink-0 rounded-md border border-slate-800 overflow-hidden">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 px-3 py-2 border-b border-slate-800">
              Effective permissions ({effective.objects.length} object
              {effective.objects.length === 1 ? '' : 's'})
            </h3>
            {effective.objects.length === 0 ? (
              <p className="px-3 py-4 text-[11px] text-slate-500">
                No grants found for this principal{schema ? ` in ${schema}` : ''}.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]" data-testid="inspector-table">
                  <thead className="bg-slate-900/60 text-slate-500">
                    <tr>
                      <th className={thCls}>Scope</th>
                      <th className={thCls}>Object</th>
                      {TABLE_PERMISSIONS.map((p) => (
                        <th key={p} className={`${thCls} text-center`}>
                          {describePermission(p).label.replace(' data', '')}
                        </th>
                      ))}
                      <th className={thCls}>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {effective.objects.map((o, i) => (
                      <EffectiveObjectRow key={i} object={o} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {effective.findings.length > 0 && (
            <section className="shrink-0 rounded-md border border-slate-800 p-3" data-testid="inspector-findings">
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5" /> Findings
              </h3>
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {effective.findings.map((f, i) => (
                  <li key={i} className="text-[11px] text-slate-400">
                    • {f}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {effective.warnings.length > 0 && (
            <section
              className="rounded-md border border-amber-500/40 bg-amber-950/25 p-3"
              data-testid="inspector-warnings"
            >
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Warnings
              </h3>
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {effective.warnings.map((w, i) => (
                  <li key={i} className="text-[11px] text-amber-200">
                    • {w}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data?.hint && <p className="text-[11px] text-slate-600">{data.hint}</p>}
        </>
      )}
    </div>
  );
};

/** The nearest explanation for a row — a reader wants one line, not every route. */
function sourceLabel(o: { permissions: { sources: AccessSource[] }[] }): string {
  for (const p of o.permissions) {
    const denied = p.sources.find((s) => s.kind === 'denied');
    if (denied) return `DENY · ${denied.via}`;
  }
  for (const p of o.permissions) {
    const direct = p.sources.find((s) => s.kind === 'direct');
    if (direct) return 'ALLOW · direct';
  }
  for (const p of o.permissions) {
    const role = p.sources.find((s) => s.kind === 'role');
    if (role) return `ALLOW · role ${role.via}`;
  }
  return '—';
}

function whyLines(sources: AccessSource[]): string[] {
  if (sources.length === 0) return ['No grant for this privilege.'];
  return sources.map((s) => {
    if (s.kind === 'denied') {
      return `DENY on ${s.via} (${s.privilege}) overrides grants.`;
    }
    if (s.kind === 'direct') {
      return `ALLOW direct${s.grantable ? ' · grantable' : ''} · ${s.privilege}`;
    }
    const path =
      s.chain.length > 0 ? s.chain.join(' → ') : s.via;
    return `ALLOW via ${path} · ${s.privilege}${s.grantable ? ' · grantable' : ''}`;
  });
}

const EffectiveObjectRow: React.FC<{ object: EffectiveObject }> = ({ object: o }) => {
  const [open, setOpen] = useState(false);
  const primarySources = o.permissions.flatMap((p) => p.sources);
  const hasWhy = primarySources.length > 0;
  return (
    <>
      <tr className="border-t border-slate-800/70">
        <td className="px-3 py-1.5 text-slate-400 font-mono">{o.schema ?? '—'}</td>
        <td className="px-3 py-1.5 text-slate-200 font-mono">
          {o.name ?? o.objectType.toLowerCase()}
        </td>
        {TABLE_PERMISSIONS.map((p) => {
          const slot = o.permissions.find((e) => e.permission === p);
          const denied = slot?.sources.some((s) => s.kind === 'denied');
          return (
            <td key={p} className="px-3 py-1.5 text-center">
              {denied ? (
                <span
                  className="inline-flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-300"
                  title="DENY"
                >
                  <ShieldX className="w-3.5 h-3.5" /> DENY
                </span>
              ) : slot?.granted ? (
                <span
                  className="inline-flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300"
                  title="ALLOW"
                >
                  <Check className="w-3.5 h-3.5" /> ALLOW
                </span>
              ) : (
                <span className="text-[10px] font-semibold text-slate-600">—</span>
              )}
            </td>
          );
        })}
        <td className="px-3 py-1.5 text-slate-500">
          <div className="flex items-center gap-1.5">
            <span>{sourceLabel(o)}</span>
            {hasWhy && (
              <button
                type="button"
                data-testid="inspector-why-toggle"
                onClick={() => setOpen((v) => !v)}
                className="text-[10px] font-bold uppercase tracking-wide text-sky-400 hover:text-sky-300"
              >
                {open ? 'Hide why' : 'Why'}
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-slate-800/40 bg-slate-950/50" data-testid="inspector-why-stack">
          <td colSpan={2 + TABLE_PERMISSIONS.length + 1} className="px-3 py-2">
            <ul className="space-y-1">
              {TABLE_PERMISSIONS.map((p) => {
                const slot = o.permissions.find((e) => e.permission === p);
                if (!slot || (!slot.granted && slot.sources.length === 0)) return null;
                return (
                  <li key={p} className="text-[11px] text-slate-400">
                    <span className="font-semibold text-slate-300">
                      {describePermission(p).label}:
                    </span>{' '}
                    {whyLines(slot.sources).join(' · ')}
                  </li>
                );
              })}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
};

const thCls = 'px-3 py-1.5 text-left font-bold uppercase tracking-wide';

const Node: React.FC<{ label: string; sub: string }> = ({ label, sub }) => (
  <div className="rounded-md border border-slate-700 bg-slate-900/50 px-2.5 py-1.5 flex items-center gap-2">
    <span className="text-[12px] font-mono text-slate-100">{label}</span>
    <span className="ml-auto text-[10px] uppercase text-slate-500">{sub}</span>
  </div>
);
