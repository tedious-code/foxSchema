/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sectioned grant/revoke UI for Database Access (live).
 *
 * General (schema/database CREATE) + Tables / Views / Procedures / Functions.
 * SQL comes from buildAccessSql / compileObjectGrid so each dialect emits the
 * GRANT/REVOKE it actually understands — not a one-size-fits-all template.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cog,
  Copy,
  Eye,
  FunctionSquare,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Shield,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import {
  accessCapabilities,
  availablePermissions,
  buildAccessSql,
  cellSupport,
  permissionBand,
  compileObjectGrid,
  describePermission,
  gridColumnsFor,
  supportsAccessBuilder,
  type AccessPermission,
  type AccessPrincipal,
  type DbPrivilege,
  type GridObjectKind,
  type PermissionRequest,
} from '@/features/access/lib/access';
import { useAllSchemaObjects } from '@/features/access/lib/useAllSchemaObjects';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { dialectFamily } from '@foxschema/sql';

type ActionMode = 'grant' | 'revoke';

const KIND_ORDER: GridObjectKind[] = ['table', 'view', 'procedure', 'function'];

const KIND_META: Record<
  GridObjectKind,
  { label: string; singular: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  table: { label: 'Tables', singular: 'table', Icon: Table2 },
  view: { label: 'Views', singular: 'view', Icon: Eye },
  procedure: { label: 'Procedures', singular: 'procedure', Icon: Cog },
  function: { label: 'Functions', singular: 'function', Icon: FunctionSquare },
};

/** Short chip labels for object-grid permissions. */
const CHIP_LABEL: Partial<Record<AccessPermission, string>> = {
  read: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  reference: 'REFERENCES',
  'index-object': 'INDEX',
  'trigger-object': 'TRIGGER',
  'alter-object': 'ALTER',
  'drop-object': 'DROP',
  'execute-procedure': 'EXECUTE',
  'execute-function': 'EXECUTE',
};

/**
 * What "create-object" means on this dialect — shown so the reader is not
 * surprised when Preview SQL does not say CREATE VIEW separately.
 */
function createObjectDialectHint(dialect: string): string {
  const caps = accessCapabilities(dialect);
  const family = caps.schemaScope
    ? 'schema'
    : caps.databaseScope
      ? 'database'
      : 'objects';
  const d = dialect.toLowerCase();
  if (dialectFamily(d) === 'postgres') {
    return 'PostgreSQL: CREATE ON SCHEMA (covers new tables/views/routines in that schema). Fine-grained CREATE VIEW/PROC are not separate grants.';
  }
  if (dialectFamily(d) === 'mysql') {
    return 'MySQL/MariaDB: CREATE (and related DDL) on database.* — there is no separate schema CREATE privilege.';
  }
  if (dialectFamily(d) === 'sqlserver') {
    return 'SQL Server: CREATE TABLE is database-scoped (GRANT CREATE TABLE TO …). Schema OBJECT grants cover existing objects.';
  }
  if (d === 'oracle') {
    return 'Oracle: CREATE TABLE / CREATE VIEW / … are system privileges (WITH ADMIN OPTION), not ON SCHEMA grants.';
  }
  if (d === 'db2') {
    return 'Db2: CREATEIN ON SCHEMA (or CREATETAB ON DATABASE) — one create privilege, not per object kind.';
  }
  return `This dialect grants create rights at the ${family} level via create-object.`;
}

/** General (non-CRUD) permissions offered for schema or database scope. */
function generalPermissionsFor(dialect: string): {
  scopeType: 'schema' | 'database';
  permissions: AccessPermission[];
} {
  const caps = accessCapabilities(dialect);
  const scopeType: 'schema' | 'database' = caps.schemaScope ? 'schema' : 'database';
  const offered = availablePermissions(dialect, scopeType);
  const general = offered.filter(
    (p) =>
      p === 'create-object' ||
      p === 'alter-object' ||
      p === 'drop-object' ||
      p === 'use-sequence' ||
      p === 'connect' ||
      p === 'execute-procedure' ||
      p === 'execute-function' ||
      p === 'reference'
  );
  return { scopeType, permissions: general };
}

function privilegeToAccess(priv: string): AccessPermission | null {
  const u = priv.toUpperCase();
  if (u === 'SELECT') return 'read';
  if (u === 'INSERT') return 'insert';
  if (u === 'UPDATE') return 'update';
  if (u === 'DELETE') return 'delete';
  if (u === 'REFERENCES') return 'reference';
  if (u === 'INDEX') return 'index-object';
  if (u === 'TRIGGER') return 'trigger-object';
  if (u === 'ALTER' || u === 'ALTER ROUTINE') return 'alter-object';
  if (u === 'DROP') return 'drop-object';
  if (u === 'EXECUTE' || u === 'EXECUTEIN') return 'execute-procedure';
  if (u === 'USAGE' && priv.toLowerCase().includes('seq')) return 'use-sequence';
  if (u === 'CREATE' || u === 'CREATEIN' || u === 'CREATETAB' || u === 'CREATE TABLE') {
    return 'create-object';
  }
  return null;
}

function objectKey(schema: string, name: string, kind: string): string {
  return `${kind}:${schema}:${name}`;
}

function requestsToSql(dialect: string, requests: PermissionRequest[]): { sql: string } | { error: string } {
  const parts: string[] = [];
  for (const req of requests) {
    const built = buildAccessSql(req, dialect);
    if ('error' in built) return { error: built.error };
    for (const s of built.statements) {
      if (s.sql.trim()) parts.push(s.sql.trim().replace(/;?\s*$/, '') + ';');
    }
  }
  if (parts.length === 0) return { error: 'No GRANT/REVOKE statements for this dialect and selection.' };
  return { sql: parts.join('\n\n') };
}

export type DbAccessConfirmRequest = {
  title: string;
  sql: string;
  kind: 'grant' | 'revoke';
};

type ObjectEditor = {
  kind: GridObjectKind;
  action: ActionMode;
  selectedKeys: string[];
  permissions: AccessPermission[];
};

type GeneralEditor = {
  action: ActionMode;
  schema: string;
  permissions: AccessPermission[];
};

interface Props {
  dialect: string;
  connectionId: string;
  database?: string;
  defaultSchema?: string;
  principal: AccessPrincipal & { kind?: string };
  privileges: DbPrivilege[];
  canGrant: boolean;
  grantSupported: boolean;
  running?: boolean;
  /**
   * Access workspace is generate-only: preview still builds GRANT/REVOKE SQL,
   * but the parent copies it or opens the SQL Editor instead of executing.
   */
  generateOnly?: boolean;
  onConfirm: (req: DbAccessConfirmRequest) => void;
  onError?: (message: string) => void;
}

/**
 * Live Database Access permission window: expand sections, edit grant/revoke,
 * dialect-correct SQL preview → parent confirm/execute.
 */
export const DbAccessPermissionSections: React.FC<Props> = ({
  dialect,
  connectionId,
  database = '',
  defaultSchema = '',
  principal,
  privileges,
  canGrant,
  grantSupported,
  running = false,
  generateOnly = false,
  onConfirm,
  onError,
}) => {
  const builderOk = supportsAccessBuilder(dialect);
  const caps = useMemo(() => accessCapabilities(dialect), [dialect]);
  const generalMeta = useMemo(() => generalPermissionsFor(dialect), [dialect]);

  const [expanded, setExpanded] = useState<Partial<Record<GridObjectKind | 'general', boolean>>>({
    general: true,
    table: false,
  });
  const catalogEnabled = KIND_ORDER.some((k) => expanded[k]);
  const catalog = useAllSchemaObjects(connectionId, catalogEnabled && builderOk);

  const schemas = useMemo(() => {
    const fromCatalog = catalog.groups.map((g) => g.schema).filter(Boolean);
    const set = new Set<string>(fromCatalog);
    if (defaultSchema) set.add(defaultSchema);
    if (set.size === 0) set.add(caps.schemaScope ? 'public' : database || '');
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [catalog.groups, defaultSchema, caps.schemaScope, database]);

  const [objectEditor, setObjectEditor] = useState<ObjectEditor | null>(null);
  const [generalEditor, setGeneralEditor] = useState<GeneralEditor | null>(null);
  const [sqlModal, setSqlModal] = useState<{
    title: string;
    sql: string;
    kind: 'grant' | 'revoke';
  } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!sqlModal && !objectEditor && !generalEditor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setSqlModal(null);
      setObjectEditor(null);
      setGeneralEditor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sqlModal, objectEditor, generalEditor]);

  const privsForObject = (schema: string, name: string): AccessPermission[] => {
    const found = new Set<AccessPermission>();
    for (const p of privileges) {
      if (p.objectType === 'ROLE') continue;
      const schemaMatch =
        !p.objectSchema || !schema || p.objectSchema.toLowerCase() === schema.toLowerCase();
      const nameMatch = (p.objectName ?? '').toLowerCase() === name.toLowerCase();
      if (!schemaMatch || !nameMatch) continue;
      const mapped = privilegeToAccess(p.privilege);
      if (mapped) found.add(mapped);
      // Catalog EXECUTE on a function row — also mark execute-function.
      if (mapped === 'execute-procedure') found.add('execute-function');
    }
    return [...found];
  };

  const objectsOfKind = (kind: GridObjectKind) =>
    catalog.objects.filter((o) => o.kind === kind).sort((a, b) => {
      const as = `${a.schema}.${a.name}`;
      const bs = `${b.schema}.${b.name}`;
      return as.localeCompare(bs);
    });

  const toggleSection = (key: GridObjectKind | 'general') => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const openObjectEdit = (
    kind: GridObjectKind,
    row: { schema: string; name: string } | null,
    action: ActionMode
  ) => {
    setGeneralEditor(null);
    const held = row ? privsForObject(row.schema, row.name) : [];
    const cols = gridColumnsFor(dialect, kind)
      .filter((c) => c.support.available)
      .map((c) => c.permission);
    const defaults = cols.slice(0, 1);
    setObjectEditor({
      kind,
      action,
      selectedKeys: row ? [objectKey(row.schema, row.name, kind)] : [],
      permissions:
        action === 'revoke'
          ? held.filter((p) => cols.includes(p))
          : held.length
            ? held.filter((p) => cols.includes(p))
            : defaults,
    });
  };

  const openGeneralEdit = (schema: string, action: ActionMode) => {
    setObjectEditor(null);
    setGeneralEditor({
      action,
      schema: schema || schemas[0] || defaultSchema || '',
      permissions:
        action === 'grant'
          ? generalMeta.permissions.includes('create-object')
            ? ['create-object']
            : generalMeta.permissions.slice(0, 1)
          : [...generalMeta.permissions.filter((p) => p === 'create-object')],
    });
  };

  const buildObjectPreview = (): { sql: string } | { error: string } => {
    if (!objectEditor) return { error: 'Nothing to preview' };
    const rows = objectEditor.selectedKeys
      .map((key) => {
        const [kind, schema, name] = key.split(':') as [GridObjectKind, string, string];
        return {
          kind,
          schema,
          name,
          permissions: objectEditor.permissions,
        };
      })
      .filter((r) => r.name);
    if (rows.length === 0) return { error: 'Select at least one object' };
    const requests = compileObjectGrid(rows, {
      dialect,
      principal: { type: principal.type, name: principal.name },
      action: objectEditor.action,
      schema: defaultSchema || schemas[0] || '',
    });
    return requestsToSql(dialect, requests);
  };

  const buildGeneralPreview = (): { sql: string } | { error: string } => {
    if (!generalEditor) return { error: 'Nothing to preview' };
    if (generalEditor.permissions.length === 0) {
      return { error: 'Select at least one general privilege' };
    }
    const scope =
      generalMeta.scopeType === 'schema'
        ? { type: 'schema' as const, schema: generalEditor.schema || defaultSchema || 'public' }
        : { type: 'database' as const, database: database || generalEditor.schema || '' };
    if (scope.type === 'schema' && !scope.schema.trim()) {
      return { error: 'Choose a schema for this dialect' };
    }
    if (scope.type === 'database' && !scope.database.trim()) {
      return { error: 'Choose a database for this dialect' };
    }
    const req: PermissionRequest = {
      principal: { type: principal.type, name: principal.name },
      action: generalEditor.action,
      permissions: generalEditor.permissions,
      scope,
    };
    return requestsToSql(dialect, [req]);
  };

  const openPreviewFromEditor = () => {
    const built = objectEditor ? buildObjectPreview() : buildGeneralPreview();
    if ('error' in built) {
      onError?.(built.error);
      setCopied(false);
      setSqlModal({
        title: 'Cannot build SQL',
        sql: `-- ${built.error}`,
        kind: (objectEditor?.action ?? generalEditor?.action) === 'revoke' ? 'revoke' : 'grant',
      });
      return;
    }
    setCopied(false);
    setSqlModal({
      title: (objectEditor?.action ?? generalEditor?.action) === 'revoke' ? 'Preview REVOKE SQL' : 'Preview GRANT SQL',
      sql: built.sql,
      kind: (objectEditor?.action ?? generalEditor?.action) === 'revoke' ? 'revoke' : 'grant',
    });
  };

  const submitSqlModal = () => {
    if (!sqlModal || sqlModal.title === 'Cannot build SQL') return;
    onConfirm({ title: sqlModal.title.replace('Preview ', ''), sql: sqlModal.sql, kind: sqlModal.kind });
    setSqlModal(null);
    setObjectEditor(null);
    setGeneralEditor(null);
  };

  const copySql = async () => {
    if (!sqlModal) return;
    try {
      await navigator.clipboard.writeText(sqlModal.sql);
      setCopied(true);
    } catch {
      onError?.('Could not copy — select the SQL manually');
    }
  };

  if (!builderOk) {
    return (
      <div
        data-testid="db-access-permission-sections"
        className="rounded-lg border border-slate-800 p-3 text-[11px] text-slate-500"
      >
        This dialect does not support the Access permission builder (
        <span className="font-mono text-slate-400">{dialect || 'unknown'}</span>
        ). Use catalog Revoke above where available, or another engine.
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="db-access-permission-sections">
      <div className="flex items-center justify-between gap-2">
        <div className={sectionLabelCls}>
          Permissions
        </div>
        <span className="text-[10px] text-slate-500 truncate">
          Dialect-aware GRANT/REVOKE · {dialect}
        </span>
      </div>
      <p className="text-[11px] text-slate-500">
        Expand a section to load objects, then <strong className="font-semibold text-slate-400">Grant</strong>{' '}
        on a row to set privileges — a row showing — holds none yet. Preview SQL uses this dialect’s
        emitter (Postgres, MySQL, SQL Server, Oracle, Db2, … each differ).
      </p>

      {/* General */}
      <section className="rounded-lg border border-slate-800 overflow-hidden" data-testid="db-access-section-general">
        <div className="flex items-center gap-2 bg-slate-900/70 px-2.5 py-1.5">
          <button
            type="button"
            data-testid="db-access-expand-general"
            aria-expanded={!!expanded.general}
            onClick={() => toggleSection('general')}
            className="flex flex-1 items-center gap-1.5 text-left text-[11px] font-bold text-slate-100"
          >
            {expanded.general ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
            )}
            <Shield className="w-3.5 h-3.5 text-slate-400" />
            General permissions
          </button>
          <button
            type="button"
            data-testid="db-access-grant-general"
            disabled={!grantSupported}
            onClick={() => openGeneralEdit(schemas[0] || defaultSchema || '', 'grant')}
            className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-100 disabled:opacity-40"
          >
            <Plus className="w-3 h-3" />
            New
          </button>
        </div>
        {expanded.general && (
          <div className="border-t border-slate-800 px-2.5 py-2 space-y-2">
            <p className="text-[10px] text-slate-500 leading-relaxed">{createObjectDialectHint(dialect)}</p>
            <p className="text-[10px] text-slate-500">
              Covers create table / view / procedure / function / type / constraint / trigger /
              sequence / FK intent where this dialect can express it — no per-row CRUD here.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {generalMeta.permissions.map((p) => {
                const d = describePermission(p);
                return (
                  <span
                    key={p}
                    title={d.description}
                    className="rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-100"
                  >
                    {d.label}
                  </span>
                );
              })}
              {generalMeta.permissions.length === 0 && (
                <span className="text-[11px] text-slate-500">No general CREATE grants on this dialect.</span>
              )}
            </div>
            {(schemas.length ? schemas : [defaultSchema || '']).filter(Boolean).map((schema) => (
              <div
                key={schema}
                className="flex items-center justify-between gap-2 border-t border-slate-800/60 pt-1.5"
                data-testid={`db-access-general-row-${schema || 'db'}`}
              >
                <span className="font-mono text-[11px] text-slate-300">
                  {generalMeta.scopeType === 'schema' ? schema : database || schema}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid={`db-access-general-edit-${schema || 'db'}`}
                    onClick={() => openGeneralEdit(schema, 'grant')}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-300"
                  >
                    <Pencil className="w-3 h-3" />
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Object kinds */}
      {KIND_ORDER.map((kind) => {
        const meta = KIND_META[kind];
        const open = !!expanded[kind];
        const rows = open ? objectsOfKind(kind) : [];
        return (
          <section
            key={kind}
            className="rounded-lg border border-slate-800 overflow-hidden"
            data-testid={`db-access-section-${kind}`}
          >
            <div className="flex items-center gap-2 bg-slate-900/70 px-2.5 py-1.5">
              <button
                type="button"
                data-testid={`db-access-expand-${kind}`}
                aria-expanded={open}
                onClick={() => toggleSection(kind)}
                className="flex flex-1 items-center gap-1.5 text-left text-[11px] font-bold text-slate-100"
              >
                {open ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                )}
                <meta.Icon className="w-3.5 h-3.5 text-slate-400" />
                {meta.label}
                {open && !catalog.loading && (
                  <span className="font-normal text-slate-500">({rows.length})</span>
                )}
                {open && catalog.loading && (
                  <Loader2 className="w-3 h-3 animate-spin text-amber-300" />
                )}
              </button>
              <button
                type="button"
                data-testid={`db-access-grant-${kind}`}
                disabled={!grantSupported}
                onClick={() => {
                  setExpanded((p) => ({ ...p, [kind]: true }));
                  openObjectEdit(kind, null, 'grant');
                }}
                className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-100 disabled:opacity-40"
              >
                <Plus className="w-3 h-3" />
                Grant
              </button>
            </div>
            {open && (
              <div className="border-t border-slate-800">
                {catalog.loading && rows.length === 0 ? (
                  <p className="px-2.5 py-3 text-[11px] text-slate-500">
                    Fetching {meta.label.toLowerCase()}…
                  </p>
                ) : rows.length === 0 ? (
                  <p className="px-2.5 py-3 text-[11px] text-slate-500">
                    No {meta.label.toLowerCase()} in catalog.
                    {catalog.error ? ` (${catalog.error})` : ''}
                  </p>
                ) : (
                  <table className="w-full text-left text-[11px]">
                    <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-2.5 py-1.5 font-bold">{meta.singular}</th>
                        <th className="px-2.5 py-1.5 font-bold">DML</th>
                        <th className="px-2.5 py-1.5 font-bold">DDL</th>
                        <th className="px-2.5 py-1.5 font-bold w-[120px]">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const held = privsForObject(row.schema, row.name);
                        const cols = new Set(
                          gridColumnsFor(dialect, kind).map((c) => c.permission)
                        );
                        const dml = held.filter((p) => permissionBand(p) === 'DML' && cols.has(p));
                        const ddl = held.filter((p) => permissionBand(p) === 'DDL' && cols.has(p));
                        return (
                          <tr
                            key={objectKey(row.schema, row.name, kind)}
                            data-testid={`db-access-obj-${row.schema}-${row.name}`}
                            className="border-t border-slate-800/80"
                          >
                            <td className="px-2.5 py-1.5 font-mono text-slate-200">
                              {row.schema ? (
                                <>
                                  <span className="text-slate-500">{row.schema}.</span>
                                  {row.name}
                                </>
                              ) : (
                                row.name
                              )}
                            </td>
                            <td className="px-2.5 py-1.5">
                              <PrivChips permissions={dml} tone="dml" />
                            </td>
                            <td className="px-2.5 py-1.5">
                              <PrivChips permissions={ddl} tone="ddl" />
                            </td>
                            <td className="px-2.5 py-1.5">
                              <div className="flex gap-2">
                                {/* "Grant" when the row holds nothing, "Edit" when it
                                    does. Both open the same editor, but a row
                                    showing — in every column has nothing to edit,
                                    and labelling it Edit hid the only way to set a
                                    permission from the people looking for it. */}
                                <button
                                  type="button"
                                  data-testid={`db-access-edit-${row.name}`}
                                  onClick={() => openObjectEdit(kind, row, 'grant')}
                                  title={
                                    held.length === 0
                                      ? `Grant privileges on ${row.name}`
                                      : `Change privileges on ${row.name}`
                                  }
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-300"
                                >
                                  {held.length === 0 ? (
                                    <Plus className="w-3 h-3" />
                                  ) : (
                                    <Pencil className="w-3 h-3" />
                                  )}
                                  {held.length === 0 ? 'Grant' : 'Edit'}
                                </button>
                                <button
                                  type="button"
                                  data-testid={`db-access-obj-revoke-${row.name}`}
                                  disabled={held.length === 0 || !grantSupported}
                                  onClick={() => openObjectEdit(kind, row, 'revoke')}
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-300 disabled:opacity-30"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  Revoke
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        );
      })}

      {/* Object editor modal */}
      {objectEditor &&
        createPortal(
          <EditorShell
            testId="db-access-object-editor"
            title={`${objectEditor.action === 'revoke' ? 'Revoke' : 'Grant'} · ${KIND_META[objectEditor.kind].label}`}
            subtitle={`→ ${principal.name} · ${dialect}`}
            onClose={() => setObjectEditor(null)}
          >
            <ActionToggle
              action={objectEditor.action}
              onChange={(action) => setObjectEditor((p) => (p ? { ...p, action } : p))}
              prefix="db-access-obj"
            />
            <div className="mb-3">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">
                {KIND_META[objectEditor.kind].label} ({objectEditor.selectedKeys.length} selected)
              </div>
              <ul
                className="max-h-40 overflow-y-auto rounded border border-slate-800 bg-slate-950/50 p-1 space-y-0.5"
                data-testid="db-access-editor-objects"
              >
                {objectsOfKind(objectEditor.kind).map((o) => {
                  const key = objectKey(o.schema, o.name, o.kind);
                  const checked = objectEditor.selectedKeys.includes(key);
                  return (
                    <li key={key}>
                      <label className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] font-mono text-slate-200 hover:bg-slate-900 cursor-pointer">
                        <input
                          type="checkbox"
                          data-testid={`db-access-pick-${o.schema}-${o.name}`}
                          checked={checked}
                          onChange={() =>
                            setObjectEditor((prev) => {
                              if (!prev) return prev;
                              const selectedKeys = prev.selectedKeys.includes(key)
                                ? prev.selectedKeys.filter((k) => k !== key)
                                : [...prev.selectedKeys, key];
                              return { ...prev, selectedKeys };
                            })
                          }
                          className="accent-amber-500"
                        />
                        <span>
                          {o.schema ? <span className="text-slate-500">{o.schema}.</span> : null}
                          {o.name}
                        </span>
                      </label>
                    </li>
                  );
                })}
                {objectsOfKind(objectEditor.kind).length === 0 && (
                  <li className="text-[11px] text-slate-500 px-2 py-2">
                    Expand the section first to load the catalog.
                  </li>
                )}
              </ul>
            </div>
            <PrivBands
              dialect={dialect}
              kind={objectEditor.kind}
              selected={objectEditor.permissions}
              onToggle={(p) =>
                setObjectEditor((prev) => {
                  if (!prev) return prev;
                  const permissions = prev.permissions.includes(p)
                    ? prev.permissions.filter((x) => x !== p)
                    : [...prev.permissions, p];
                  return { ...prev, permissions };
                })
              }
            />
            <PreviewButton
              action={objectEditor.action}
              onClick={openPreviewFromEditor}
              testId="db-access-preview-sql"
            />
          </EditorShell>,
          document.body
        )}

      {/* General editor modal */}
      {generalEditor &&
        createPortal(
          <EditorShell
            testId="db-access-general-editor"
            title={`${generalEditor.action === 'revoke' ? 'Revoke' : 'Grant'} general privilege`}
            subtitle={`→ ${principal.name} · ${dialect}`}
            onClose={() => setGeneralEditor(null)}
          >
            <ActionToggle
              action={generalEditor.action}
              onChange={(action) => setGeneralEditor((p) => (p ? { ...p, action } : p))}
              prefix="db-access-general"
            />
            {generalMeta.scopeType === 'schema' ? (
              <label className="flex flex-col gap-1 text-[11px] text-slate-400 mb-3">
                Schema
                <select
                  data-testid="db-access-general-schema"
                  value={generalEditor.schema}
                  onChange={(e) =>
                    setGeneralEditor((p) => (p ? { ...p, schema: e.target.value } : p))
                  }
                  className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100 font-mono"
                >
                  {schemas.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-[11px] text-slate-500 mb-3 font-mono">
                Database: {database || generalEditor.schema || '(connection database)'}
              </p>
            )}
            <p className="text-[10px] text-slate-500 mb-2">{createObjectDialectHint(dialect)}</p>
            <div className="flex flex-wrap gap-2 mb-4" data-testid="db-access-general-privs">
              {generalMeta.permissions.map((p) => {
                const on = generalEditor.permissions.includes(p);
                const d = describePermission(p);
                return (
                  <button
                    key={p}
                    type="button"
                    title={d.description}
                    data-testid={`db-access-general-priv-${p}`}
                    onClick={() =>
                      setGeneralEditor((prev) => {
                        if (!prev) return prev;
                        const permissions = prev.permissions.includes(p)
                          ? prev.permissions.filter((x) => x !== p)
                          : [...prev.permissions, p];
                        return { ...prev, permissions };
                      })
                    }
                    className={`rounded-md border px-2 py-1.5 text-[11px] font-semibold ${
                      on
                        ? 'border-violet-500/50 bg-violet-500/20 text-violet-50'
                        : 'border-slate-700 text-slate-400'
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <PreviewButton
              action={generalEditor.action}
              onClick={openPreviewFromEditor}
              testId="db-access-general-preview-sql"
            />
          </EditorShell>,
          document.body
        )}

      {/* SQL preview modal */}
      {sqlModal &&
        createPortal(
          <div
            className="fixed inset-0 z-[340] flex items-center justify-center bg-black/70 p-4"
            onClick={() => setSqlModal(null)}
            data-testid="db-access-sql-modal-backdrop"
          >
            <div
              className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              data-testid="db-access-sql-modal"
              role="dialog"
              aria-modal="true"
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <h3 className="text-sm font-bold text-slate-100">{sqlModal.title}</h3>
                <button data-testid="db-access-grant-sql-open" type="button" onClick={() => setSqlModal(null)} className="text-slate-500 hover:text-slate-200">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <pre
                data-testid="db-access-sql-modal-sql"
                className="text-[11px] font-mono text-slate-300 bg-slate-950 border border-slate-800 rounded px-3 py-2 mb-3 overflow-x-auto whitespace-pre-wrap max-h-64"
              >
                {sqlModal.sql}
              </pre>
              <div className="flex flex-wrap justify-end gap-2">
                <button data-testid="db-access-sql-modal-cancel"
                  type="button"
                  className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
                  onClick={() => setSqlModal(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="db-access-sql-copy"
                  onClick={() => void copySql()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-600 px-3 py-1.5 text-xs font-bold text-slate-100 hover:bg-slate-800"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy SQL'}
                </button>
                <button
                  type="button"
                  data-testid="db-access-sql-modal-run"
                  disabled={(!generateOnly && !canGrant) || running || !grantSupported}
                  onClick={submitSqlModal}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-bold disabled:opacity-40 ${
                    sqlModal.kind === 'revoke'
                      ? 'border-rose-500/50 bg-rose-500/20 text-rose-50'
                      : 'border-amber-500/40 bg-amber-500/15 text-amber-100'
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {generateOnly
                    ? 'Use this SQL'
                    : canGrant
                      ? sqlModal.kind === 'revoke'
                        ? 'Execute revoke'
                        : 'Execute grant'
                      : 'Cannot execute'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

const PrivChips: React.FC<{ permissions: AccessPermission[]; tone: 'dml' | 'ddl' }> = ({
  permissions,
  tone,
}) => {
  if (permissions.length === 0) return <span className="text-slate-600">—</span>;
  const cls =
    tone === 'dml'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : 'border-orange-500/30 bg-orange-500/10 text-orange-200';
  return (
    <div className="flex flex-wrap gap-1">
      {permissions.map((p) => (
        <span key={p} className={`rounded border px-1 py-0.5 text-[10px] font-semibold font-mono ${cls}`}>
          {CHIP_LABEL[p] ?? p}
        </span>
      ))}
    </div>
  );
};

const PrivBands: React.FC<{
  dialect: string;
  kind: GridObjectKind;
  selected: AccessPermission[];
  onToggle: (p: AccessPermission) => void;
}> = ({ dialect, kind, selected, onToggle }) => {
  const cols = gridColumnsFor(dialect, kind);
  const dml = cols.filter((c) => permissionBand(c.permission) === 'DML');
  const ddl = cols.filter((c) => permissionBand(c.permission) === 'DDL');
  const Band = ({
    title,
    list,
  }: {
    title: string;
    list: { permission: AccessPermission; support: ReturnType<typeof cellSupport> }[];
  }) => (
    <div className="rounded-lg border border-slate-800 p-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1.5">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {list.map(({ permission: p, support }) => {
          const on = selected.includes(p);
          return (
            <button
              key={p}
              type="button"
              title={support.reason}
              disabled={!support.available}
              data-testid={`db-access-priv-${p}`}
              onClick={() => onToggle(p)}
              className={`rounded-md border px-2 py-1 text-[11px] font-mono font-semibold disabled:opacity-30 ${
                on
                  ? 'border-amber-500/50 bg-amber-500/20 text-amber-50'
                  : 'border-slate-700 text-slate-400'
              }`}
            >
              {CHIP_LABEL[p] ?? describePermission(p).label}
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    <div className="grid gap-2 sm:grid-cols-2 mb-3">
      <Band title="DML" list={dml} />
      <Band title="DDL" list={ddl} />
    </div>
  );
};

const ActionToggle: React.FC<{
  action: ActionMode;
  onChange: (a: ActionMode) => void;
  prefix: string;
}> = ({ action, onChange, prefix }) => (
  <div className="flex gap-2 mb-3">
    <button
      type="button"
      data-testid={`${prefix}-action-grant`}
      onClick={() => onChange('grant')}
      className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
        action === 'grant'
          ? 'border-amber-500/50 bg-amber-500/20 text-amber-50'
          : 'border-slate-700 text-slate-400'
      }`}
    >
      Grant
    </button>
    <button
      type="button"
      data-testid={`${prefix}-action-revoke`}
      onClick={() => onChange('revoke')}
      className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
        action === 'revoke'
          ? 'border-rose-500/50 bg-rose-500/20 text-rose-50'
          : 'border-slate-700 text-slate-400'
      }`}
    >
      Revoke
    </button>
  </div>
);

const PreviewButton: React.FC<{
  action: ActionMode;
  onClick: () => void;
  testId: string;
}> = ({ action, onClick, testId }) => (
  <button
    type="button"
    data-testid={testId}
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-bold ${
      action === 'revoke'
        ? 'border-rose-500/50 bg-rose-500/20 text-rose-50'
        : 'border-amber-500/40 bg-amber-500/15 text-amber-100'
    }`}
  >
    <KeyRound className="w-3.5 h-3.5" />
    Preview SQL
  </button>
);

const EditorShell: React.FC<{
  testId: string;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ testId, title, subtitle, onClose, children }) => (
  <div
    className="fixed inset-0 z-[330] flex items-center justify-center bg-black/70 p-4"
    onClick={onClose}
  >
    <div
      className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl max-h-[90vh] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
      data-testid={testId}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-bold text-slate-100">{title}</h3>
          <p className="text-[11px] text-slate-500 mt-0.5 font-mono">{subtitle}</p>
        </div>
        <button data-testid="db-access-close" type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200">
          <X className="w-4 h-4" />
        </button>
      </div>
      {children}
    </div>
  </div>
);
