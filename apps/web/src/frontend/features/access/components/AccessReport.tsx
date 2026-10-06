import React, { useMemo, useRef, useState } from 'react';
import { RefreshCw, AlertTriangle, Users, KeyRound, Search, UserCog } from 'lucide-react';
import { fetchDbAccess } from '@/shared/api/schemaApi';
import { useSyncStore } from '@/app/store/useSyncStore';
import { useSqlEditorStore } from '@/app/store/useSqlEditorStore';
import { buildAccessReport, principalsWithAccessTo, type AccessReport as Report } from '../lib/access';
import type { DbPrincipal, DbPrivilege } from '@foxschema/ui-shared';
import { inputCls, labelCls } from './controls';
import { connectionOptionLabel } from '@/shared/lib/dialectLabel';

const RISK_STYLE: Record<string, string> = {
  low: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  elevated: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  critical: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
};

/**
 * Who can access what, across every principal at once.
 *
 * Runs the Inspector's resolver per principal rather than a second aggregation
 * of its own, so the summary table and the detail view can never disagree about
 * who holds what.
 */
export const AccessReport: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const connections = useSyncStore((s) => s.connections);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const [connectionId, setConnectionId] = useState('');
  const [schema, setSchema] = useState('');
  const [objectQuery, setObjectQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ principals: DbPrincipal[]; privileges: DbPrivilege[] } | null>(
    null
  );
  const loadToken = useRef(0);

  const conn = connections.find((c) => c.id === connectionId) || null;

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
      setData({ principals: res.principals ?? [], privileges: res.privileges ?? [] });
    } catch (e: unknown) {
      if (superseded()) return;
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      if (!superseded()) setLoading(false);
    }
  };

  const report: Report | null = useMemo(
    () => (data ? buildAccessReport({ ...data, schema: schema || undefined }) : null),
    [data, schema]
  );

  const whoCanAccess = useMemo(() => {
    if (!data || !objectQuery.trim()) return null;
    return principalsWithAccessTo({
      ...data,
      schema: schema || null,
      object: objectQuery.trim(),
    });
  }, [data, objectQuery, schema]);

  return (
    <div
      className={`flex-1 flex flex-col min-h-0 overflow-y-auto gap-4 ${
        embedded ? 'p-4' : 'p-5'
      }`}
      data-testid="access-report"
    >
      <div className="shrink-0">
        <h2 className="text-sm font-bold text-slate-100">
          {embedded ? 'Access report' : 'Users and Roles'}
        </h2>
        <p className="text-[11px] text-slate-500 mt-0.5">
          A summary of who can access what. Read-only — Fox Schema changes nothing here.
        </p>
      </div>

      <div className="shrink-0 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 min-w-[16rem] flex-1">
          <span className={labelCls}>Database</span>
          <select
            data-testid="report-connection"
            value={connectionId}
            onChange={(e) => {
              loadToken.current++;
              setConnectionId(e.target.value);
              setData(null);
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
        <label className="flex flex-col gap-1 w-40">
          <span className={labelCls}>Schema</span>
          <input
            data-testid="report-schema"
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            placeholder={conn?.schema || 'all schemas'}
            className={`${inputCls} font-mono`}
          />
        </label>
        <button
          type="button"
          data-testid="report-load"
          onClick={load}
          disabled={!connectionId || loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-sky-500/40 bg-sky-500/15 text-xs font-bold text-sky-100 disabled:opacity-40"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Building…' : 'Build report'}
        </button>
      </div>

      {error && (
        <div
          data-testid="report-error"
          className="shrink-0 rounded-md border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200"
        >
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="shrink-0 grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="report-tiles">
            {/* Roles and privileges are counted in different units — principals
                versus grants — so they do not share an icon. */}
            <Tile icon={Users} label="Users" value={report.principals.length - report.roleCount} />
            <Tile icon={UserCog} label="Roles" value={report.roleCount} />
            <Tile icon={KeyRound} label="Granted privileges" value={report.grantedPrivilegeCount} />
            <Tile
              icon={AlertTriangle}
              label="High-risk findings"
              value={report.findings.length}
              alert={report.findings.length > 0}
            />
          </div>

          <section className="shrink-0 rounded-md border border-slate-800 overflow-hidden">
            <h3 className={sectionHeadCls}>Access overview</h3>
            {report.principals.length === 0 ? (
              <p className="px-3 py-4 text-[11px] text-slate-500">
                No principal holds any grant{schema ? ` in ${schema}` : ''}.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]" data-testid="report-table">
                  <thead className="bg-slate-900/60 text-slate-500">
                    <tr>
                      {['Principal', 'Type', 'Scope', 'Access type', 'Risk', 'Source', 'Objects'].map(
                        (h) => (
                          <th key={h} className={thCls}>
                            {h}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {report.principals.map((p) => (
                      <tr key={p.principal} className="border-t border-slate-800/70">
                        <td className="px-3 py-1.5 font-mono text-slate-200">{p.principal}</td>
                        <td className="px-3 py-1.5 text-slate-500">{p.kind}</td>
                        <td className="px-3 py-1.5 font-mono text-slate-400">{p.scope}</td>
                        <td className="px-3 py-1.5 text-slate-300">{p.accessType}</td>
                        <td className="px-3 py-1.5">
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${RISK_STYLE[p.risk]}`}
                          >
                            {p.risk}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-slate-500">{p.source}</td>
                        <td className="px-3 py-1.5 text-slate-400">{p.objectCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {report.findings.length > 0 && (
            <section
              className="shrink-0 rounded-md border border-rose-500/40 bg-rose-950/20 p-3"
              data-testid="report-findings"
            >
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-rose-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> High-risk findings ({report.findings.length})
              </h3>
              <ul className="mt-1.5 flex flex-col gap-1">
                {report.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px]">
                    <span
                      className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase ${RISK_STYLE[f.severity]}`}
                    >
                      {f.severity}
                    </span>
                    <span className="text-slate-300">{f.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="shrink-0 rounded-md border border-slate-800 p-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
              <Search className="w-3.5 h-3.5" /> Who can access this object?
            </h3>
            <input
              data-testid="report-object-query"
              value={objectQuery}
              onChange={(e) => setObjectQuery(e.target.value)}
              placeholder="table name, e.g. payments"
              className={`${inputCls} font-mono mt-2 max-w-sm`}
            />
            {whoCanAccess && (
              <div className="mt-2" data-testid="report-who">
                {whoCanAccess.length === 0 ? (
                  <p className="text-[11px] text-slate-500">
                    No principal holds a grant on “{objectQuery}”
                    {schema ? ` in ${schema}` : ''}.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {whoCanAccess.map((w) => (
                      <li key={w.principal} className="flex items-center gap-2 text-[11px]">
                        <span className="font-mono text-slate-200">{w.principal}</span>
                        <span className="text-slate-600">{w.kind}</span>
                        <span className="ml-auto font-mono text-slate-400">
                          {w.permissions.join(', ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};


const thCls = 'px-3 py-1.5 text-left font-bold uppercase tracking-wide';
const sectionHeadCls =
  'text-[11px] font-bold uppercase tracking-wide text-slate-500 px-3 py-2 border-b border-slate-800';

const Tile: React.FC<{
  icon: React.ElementType;
  label: string;
  value: number;
  alert?: boolean;
}> = ({ icon: Icon, label, value, alert }) => (
  <div
    className={`rounded-md border px-3 py-2 ${
      alert ? 'border-rose-500/40 bg-rose-950/20' : 'border-slate-800 bg-slate-900/40'
    }`}
  >
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500">
      <Icon className={`w-3.5 h-3.5 ${alert ? 'text-rose-400' : 'text-slate-500'}`} />
      {label}
    </div>
    <div className={`mt-0.5 text-lg font-bold ${alert ? 'text-rose-200' : 'text-slate-100'}`}>
      {value}
    </div>
  </div>
);
