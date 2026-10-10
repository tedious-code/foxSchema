import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Check, AlertTriangle, RefreshCw, Plus, Trash2 } from 'lucide-react';
import {
  accessCapabilities,
  availablePermissions,
  buildAccessReconciliationSql,
  buildAccessSql,
  diffAccessDesired,
  permissionsForPreset,
  type AccessDesiredState,
  type AccessPermission,
  type AccessScope,
  type DbPrivilege,
  type PermissionRequest,
} from '../lib/access';
import { dialectFeatureReason } from '@/shared/lib/dialect-features';
import { EmptyState, Field, Segmented, inputCls } from '@/shared/components/controls';
import { Autocomplete } from '@/shared/components/Autocomplete';
import { ObjectPicker } from './ObjectPicker';
import { useAccessCatalog } from '../lib/useAccessCatalog';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { fetchDbAccess } from '@/shared/api/schemaApi';
import { writeClipboard } from '@/shared/utils/clipboard';
import { connectionOptionLabel } from '@/shared/lib/dialectLabel';

const STATUS_STYLE: Record<string, string> = {
  match: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  missing: 'text-amber-200 bg-amber-500/10 border-amber-500/30',
  extra: 'text-rose-200 bg-rose-500/10 border-rose-500/30',
  denied: 'text-violet-200 bg-violet-500/10 border-violet-500/30',
};

function defaultScopeType(caps: ReturnType<typeof accessCapabilities>): AccessScope['type'] {
  if (caps.schemaScope) return 'schema';
  if (caps.databaseScope) return 'database';
  if (caps.tableScope) return 'tables';
  if (caps.columnScope) return 'columns';
  if (caps.sequenceScope) return 'sequences';
  return 'schema';
}

function emptyRequest(scopeType: AccessScope['type'] = 'schema'): PermissionRequest {
  const scope: AccessScope =
    scopeType === 'database'
      ? { type: 'database', database: '' }
      : scopeType === 'tables'
        ? { type: 'tables', schema: '', tables: [] }
        : scopeType === 'columns'
          ? { type: 'columns', schema: '', table: '', columns: [] }
          : scopeType === 'sequences'
            ? { type: 'sequences', schema: '' }
            : { type: 'schema', schema: '' };
  return {
    principal: { type: 'user', name: '' },
    action: 'grant',
    permissions: permissionsForPreset('read-only'),
    scope,
  };
}

/**
 * Phase D — compare desired grants against the live catalog and generate
 * reconciliation SQL. Generate-only; Fox Schema never applies changes.
 */
export const PermissionDiff: React.FC<{
  lockedConnectionId?: string;
  onConnectionChange?: (id: string) => void;
}> = ({ lockedConnectionId, onConnectionChange }) => {
  const connections = useSyncStore((s) => s.connections);
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);

  const [localConnectionId, setLocalConnectionId] = useState('');
  const connectionId = lockedConnectionId ?? localConnectionId;
  const pickConnection = (id: string) => {
    onConnectionChange?.(id);
    if (lockedConnectionId === undefined) setLocalConnectionId(id);
  };
  const conn = connections.find((c) => c.id === connectionId) || null;
  const dialect = conn?.dialect ?? '';

  const [principalName, setPrincipalName] = useState('');
  const [principalType, setPrincipalType] = useState<'user' | 'role'>('user');
  const [requests, setRequests] = useState<PermissionRequest[]>([emptyRequest()]);

  const [privileges, setPrivileges] = useState<DbPrivilege[]>([]);
  /**
   * The connection a catalog read has completed for.
   *
   * Kept as the id rather than a boolean so switching connection reverts the
   * panel to "not loaded" instead of describing the previous database's read.
   * Diff and reconciliation SQL must only use privileges when this matches
   * the selected connection — otherwise a stale catalog from another database
   * generates GRANT/REVOKE the reader would paste against the wrong engine.
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /**
   * Which catalog read is current. Same race User Management fixed: Oracle is
   * slow, switching mid-read lets the old response land afterwards and drive
   * reconciliation SQL from the wrong database's privileges.
   */
  const loadToken = useRef(0);

  const catalog = useAccessCatalog(connectionId, conn);
  const caps = useMemo(() => accessCapabilities(dialect), [dialect]);
  // MySQL/MariaDB defaulted every Diff row to schema scope, which the emitter
  // rejects — reconciliation SQL stayed empty until the reader changed scope.
  useEffect(() => {
    const prefer = defaultScopeType(caps);
    setRequests((prev) => {
      let changed = false;
      const next = prev.map((r) => {
        const allowed =
          (r.scope.type === 'schema' && caps.schemaScope) ||
          (r.scope.type === 'database' && caps.databaseScope) ||
          (r.scope.type === 'tables' && caps.tableScope) ||
          (r.scope.type === 'columns' && caps.columnScope) ||
          (r.scope.type === 'sequences' && caps.sequenceScope);
        if (allowed) return r;
        changed = true;
        return { ...r, ...emptyRequest(prefer), principal: r.principal, action: r.action, permissions: r.permissions };
      });
      return changed ? next : prev;
    });
  }, [caps]);

  // Drop the previous connection's privileges the moment the selection changes.
  // Without this, privileges.length > 0 keeps feeding diff/reconciliation from
  // the old database while the UI already names the new one.
  useEffect(() => {
    loadToken.current++;
    setPrivileges([]);
    setLoadedFor(null);
    setLoadError(null);
    setLoading(false);
  }, [connectionId]);

  const principalOptions = useMemo(
    () =>
      catalog.principalOptions.filter((o) => {
        const p = catalog.principals.find((x) => x.name === o.value);
        if (!p) return true;
        return principalType === 'user' ? p.kind === 'user' : p.kind !== 'user';
      }),
    [catalog.principalOptions, catalog.principals, principalType]
  );

  const desired: AccessDesiredState = useMemo(
    () => ({
      principal: { type: principalType, name: principalName },
      requests: requests.map((r) => ({
        ...r,
        principal: { type: principalType, name: principalName },
      })),
    }),
    [principalType, principalName, requests]
  );

  const catalogReady = loadedFor === connectionId && connectionId !== '';

  const diff = useMemo(() => {
    if (!principalName.trim() || !catalogReady || privileges.length === 0) return null;
    return diffAccessDesired(desired, privileges);
  }, [desired, privileges, principalName, catalogReady]);

  const reconciliation = useMemo(() => {
    if (!diff || !dialect) return null;
    return buildAccessReconciliationSql(diff, dialect);
  }, [diff, dialect]);

  const previewSql = useMemo(() => {
    if (reconciliation && !('error' in reconciliation)) {
      return reconciliation.statements.map((s) => s.sql).join('\n\n');
    }
    return requests
      .map((r) => {
        const built = dialect ? buildAccessSql(r, dialect) : null;
        if (!built || 'error' in built) return '';
        return built.statements.map((s) => s.sql).join('\n');
      })
      .filter(Boolean)
      .join('\n\n');
  }, [reconciliation, requests, dialect]);

  const loadCatalog = async () => {
    if (!connectionId || !conn) return;
    const token = ++loadToken.current;
    const superseded = () => loadToken.current !== token;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchDbAccess(
        { connectionId, password: sessionPasswords[connectionId] || undefined },
        { schema: conn?.schema || undefined, force: true }
      );
      if (superseded()) return;
      setPrivileges(res.privileges ?? []);
      setLoadedFor(connectionId);
    } catch (e) {
      if (superseded()) return;
      setLoadError(e instanceof Error ? e.message : String(e));
      setPrivileges([]);
      setLoadedFor(null);
    } finally {
      if (!superseded()) setLoading(false);
    }
  };

  const addRow = () => setRequests((prev) => [...prev, emptyRequest(defaultScopeType(caps))]);
  const removeRow = (i: number) => setRequests((prev) => prev.filter((_, j) => j !== i));
  const updateRow = (i: number, patch: Partial<PermissionRequest>) =>
    setRequests((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const copy = async () => {
    if (!previewSql) return;
    if (!(await writeClipboard(previewSql))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  // Was `supportsAccessBuilder` plus "<dialect> has no GRANT model for
  // diffing" — dropped because it is false of all three engines that reach
  // it. Adjacent tabs of one screen were about to give ClickHouse two
  // different answers.
  const accessBlockedBy = dialect ? dialectFeatureReason(dialect, 'dbAccess') : undefined;

  return (
    <div className="flex-1 flex min-h-0" data-testid="permission-diff">
      <div className="w-[46%] min-w-[380px] overflow-y-auto border-r border-slate-800 p-5 flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-bold text-slate-100">Permission Diff</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Define the access you want, load the live catalog, and copy reconciliation SQL for
            gaps. Fox Schema never applies it.
          </p>
        </div>

        <div className={lockedConnectionId !== undefined ? 'sr-only' : undefined}>
        <Field label="Database">
          <select
            data-testid="diff-connection"
            value={connectionId}
            onChange={(e) => pickConnection(e.target.value)}
            className={inputCls}
          >
            <option value="">Choose a saved connection…</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {connectionOptionLabel(c)}
              </option>
            ))}
            </select>
          </Field>
        </div>

        {accessBlockedBy ? (
          <div
            data-testid="diff-unsupported"
            className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2.5 text-[11px] text-slate-400"
          >
            {accessBlockedBy}
          </div>
        ) : (
          <>
            <Field label="Principal">
              <div className="flex gap-2">
                <Segmented
                  value={principalType}
                  onChange={(v) => setPrincipalType(v as 'user' | 'role')}
                  options={[
                    { value: 'user', label: 'User' },
                    { value: 'role', label: 'Role' },
                  ]}
                  testId="diff-principal-type"
                />
                <Autocomplete
                  data-testid="diff-principal-name"
                  theme="slate"
                  value={principalName}
                  onChange={setPrincipalName}
                  options={principalOptions}
                  placeholder="report_user"
                  className={`${inputCls} flex-1 font-mono`}
                />
              </div>
            </Field>

            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="diff-load-catalog"
                disabled={!connectionId || loading}
                onClick={() => void loadCatalog()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-600 text-[11px] font-semibold text-slate-200 disabled:opacity-40"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                Load catalog
              </button>
              {loadError && (
                <span data-testid="diff-load-error" className="text-[11px] text-rose-300">
                  {loadError}
                </span>
              )}
            </div>

            <Field label="Desired access">
              <div className="flex flex-col gap-3">
                {requests.map((req, i) => (
                  <DesiredRow
                    key={i}
                    index={i}
                    req={req}
                    dialect={dialect}
                    caps={caps}
                    catalog={catalog}
                    onChange={(patch) => updateRow(i, patch)}
                    onRemove={() => removeRow(i)}
                    canRemove={requests.length > 1}
                  />
                ))}
                <button
                  type="button"
                  data-testid="diff-add-row"
                  onClick={addRow}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-300 hover:text-sky-100"
                >
                  <Plus className="w-3.5 h-3.5" /> Add desired grant
                </button>
              </div>
            </Field>
          </>
        )}
      </div>

      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2 shrink-0">
          <span className="text-xs font-bold text-slate-300">Diff &amp; SQL</span>
          <button
            type="button"
            data-testid="diff-copy-sql"
            disabled={!previewSql}
            onClick={() => void copy()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-sky-500/40 bg-sky-500/15 text-[11px] font-bold text-sky-100 disabled:opacity-40"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            Copy SQL
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 min-h-0">
          {!principalName.trim() ? (
            <EmptyState
              title="Choose a principal"
              body="Enter a principal and define desired access."
            />
          ) : !diff ? (
            // Two different situations used to read identically. A catalog that
            // loaded and returned nothing left this saying "Load the catalog",
            // so the button appeared to do nothing at all — which is what
            // Oracle and TiDB do here, where the catalog read succeeds and
            // comes back with no privilege rows.
            <EmptyState
              testId="diff-empty"
              title={catalogReady ? 'No privileges found' : 'Load the catalog'}
              body={
                catalogReady
                  ? 'The catalog loaded, but this database reported no privileges to compare against. Anything you ask for below will show as missing.'
                  : 'Load the catalog to compare desired vs live privileges.'
              }
            />
          ) : (
            <>
              <div data-testid="diff-summary" className="flex flex-wrap gap-2 text-[11px]">
                <span className="rounded px-2 py-0.5 border border-emerald-500/30 text-emerald-200">
                  {diff.summary.match} match
                </span>
                <span className="rounded px-2 py-0.5 border border-amber-500/30 text-amber-200">
                  {diff.summary.missing} missing — will be granted
                </span>
                <span className="rounded px-2 py-0.5 border border-rose-500/30 text-rose-200">
                  {diff.summary.extra} extra — will be revoked
                </span>
              </div>

              <table className="w-full text-[11px] border-collapse" data-testid="diff-table">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-800">
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.entries.map((e, i) => (
                    <tr key={i} className="border-b border-slate-900" data-testid={`diff-row-${i}`}>
                      <td className="py-1.5 pr-2 align-top">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 border text-[10px] font-bold uppercase ${STATUS_STYLE[e.status] ?? ''}`}
                        >
                          {e.status}
                        </span>
                      </td>
                      <td className="py-1.5 text-slate-300">{e.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {reconciliation &&
                'error' in reconciliation &&
                diff.summary.missing + diff.summary.extra === 0 && (
                  <p className="text-[11px] text-emerald-300">{reconciliation.error}</p>
                )}

              {previewSql ? (
                <pre
                  data-testid="diff-sql-preview"
                  className="rounded-md border border-slate-800 bg-slate-950 p-3 text-[11px] font-mono text-slate-200 whitespace-pre-wrap"
                >
                  {previewSql}
                </pre>
              ) : reconciliation && 'error' in reconciliation ? (
                <p className="text-[11px] text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  {reconciliation.error}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const DesiredRow: React.FC<{
  index: number;
  req: PermissionRequest;
  dialect: string;
  caps: ReturnType<typeof accessCapabilities>;
  catalog: ReturnType<typeof useAccessCatalog>;
  onChange: (patch: Partial<PermissionRequest>) => void;
  onRemove: () => void;
  canRemove: boolean;
}> = ({ index, req, dialect, caps, catalog, onChange, onRemove, canRemove }) => {
  const scopeType = req.scope.type;
  const tableScope = req.scope.type === 'tables' ? req.scope : null;
  const columnScope = req.scope.type === 'columns' ? req.scope : null;
  const schemaName =
    req.scope.type === 'schema'
      ? req.scope.schema
      : tableScope?.schema ?? columnScope?.schema ?? '';
  const tableChoices = catalog.tablesInSchema(schemaName);
  const columnChoices = columnScope
    ? catalog.columnsInTable(columnScope.schema, columnScope.table)
    : [];

  const offered = availablePermissions(dialect, scopeType);

  const setScopeType = (t: AccessScope['type']) => {
    if (t === 'database') onChange({ scope: { type: 'database', database: '' } });
    else if (t === 'tables') onChange({ scope: { type: 'tables', schema: '', tables: [] } });
    else if (t === 'columns') onChange({ scope: { type: 'columns', schema: '', table: '', columns: [] } });
    else if (t === 'sequences') onChange({ scope: { type: 'sequences', schema: '' } });
    else onChange({ scope: { type: 'schema', schema: '' } });
  };

  const togglePerm = (p: AccessPermission) => {
    const next = req.permissions.includes(p)
      ? req.permissions.filter((x) => x !== p)
      : [...req.permissions, p];
    onChange({ permissions: next });
  };

  return (
    <div
      className="rounded-md border border-slate-800 p-3 flex flex-col gap-2"
      data-testid={`diff-desired-${index}`}
    >
      <div className="flex items-center justify-between gap-2">
        <Segmented
          value={req.action}
          onChange={(v) => onChange({ action: v as PermissionRequest['action'] })}
          options={[
            { value: 'grant', label: 'Grant' },
            ...(caps.denyStatements ? [{ value: 'deny', label: 'Deny' }] : []),
          ]}
          testId={`diff-action-${index}`}
        />
        {canRemove && (
          <button data-testid={`diff-remove-${index}`} type="button" onClick={onRemove} className="text-slate-500 hover:text-rose-300">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <Segmented
        value={scopeType}
        onChange={(v) => setScopeType(v as AccessScope['type'])}
        options={[
          ...(caps.schemaScope ? [{ value: 'schema', label: 'Schema' }] : []),
          ...(caps.tableScope ? [{ value: 'tables', label: 'Tables' }] : []),
          ...(caps.columnScope ? [{ value: 'columns', label: 'Columns' }] : []),
          ...(caps.sequenceScope ? [{ value: 'sequences', label: 'Sequences' }] : []),
        ]}
        testId={`diff-scope-${index}`}
      />

      {scopeType === 'schema' && (
        <Autocomplete
          data-testid={`diff-schema-${index}`}
          theme="slate"
          value={req.scope.type === 'schema' ? req.scope.schema : ''}
          onChange={(schema) => onChange({ scope: { type: 'schema', schema } })}
          options={catalog.schemaOptions}
          placeholder="schema"
          className={`${inputCls} font-mono`}
        />
      )}
      {scopeType === 'tables' && tableScope && (
        <>
          <Autocomplete
            theme="slate"
            value={tableScope.schema}
            onChange={(schema) =>
              onChange({ scope: { type: 'tables', schema, tables: tableScope.tables } })
            }
            options={catalog.schemaOptions}
            placeholder="schema"
            className={`${inputCls} font-mono`}
          />
          <ObjectPicker
            testId={`diff-tables-${index}`}
            label="Tables"
            items={tableChoices}
            selected={tableScope.tables}
            onChange={(tables) =>
              onChange({ scope: { type: 'tables', schema: tableScope.schema, tables } })
            }
          />
        </>
      )}
      {scopeType === 'columns' && columnScope && (
        <>
          <Autocomplete
            theme="slate"
            value={columnScope.schema}
            onChange={(schema) =>
              onChange({
                scope: {
                  type: 'columns',
                  schema,
                  table: columnScope.table,
                  columns: columnScope.columns,
                },
              })
            }
            options={catalog.schemaOptions}
            placeholder="schema"
            className={`${inputCls} font-mono`}
          />
          <Autocomplete
            theme="slate"
            value={columnScope.table}
            onChange={(table) =>
              onChange({
                scope: {
                  type: 'columns',
                  schema: columnScope.schema,
                  table,
                  columns: columnScope.columns,
                },
              })
            }
            options={tableChoices.map((t) => ({ value: t }))}
            placeholder="table"
            className={`${inputCls} font-mono`}
          />
          <ObjectPicker
            testId={`diff-columns-${index}`}
            label="Columns"
            items={columnChoices}
            selected={columnScope.columns}
            onChange={(columns) =>
              onChange({
                scope: {
                  type: 'columns',
                  schema: columnScope.schema,
                  table: columnScope.table,
                  columns,
                },
              })
            }
          />
        </>
      )}

      <div className="flex flex-wrap gap-1">
        {offered.map((p) => (
          <label key={p} className="inline-flex items-center gap-1 text-[10px] text-slate-400">
            <input data-testid={`diff-permission-${index}-${p}`}
              type="checkbox"
              checked={req.permissions.includes(p)}
              onChange={() => togglePerm(p)}
            />
            {p}
          </label>
        ))}
      </div>
    </div>
  );
};
