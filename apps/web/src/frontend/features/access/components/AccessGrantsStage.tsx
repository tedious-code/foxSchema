/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Access → Grants stage: presets + object×privilege matrix + GRANT SQL.
 * Generate-only — matches the Access mockup chrome.
 *
 * The grid opens on what the principal holds now, and the SQL is only the
 * difference: a new tick is a GRANT, a held box cleared is a REVOKE. It used to
 * open empty and compare the ticks with the whole catalog, so an existing
 * role looked like it held nothing, and ticking one box revoked everything
 * else it had — CONNECT on the database included.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Copy, FileCode2 } from 'lucide-react';
import {
  buildAccessSql,
  splitHeldPrivileges,
  describeHeldPrivilege,
  permissionsForPreset,
  type AccessPermission,
  type AccessPreset,
  type DbPrivilege,
  type GridChanges,
  type PermissionRequest,
} from '../lib/access';
import { useAllSchemaObjects } from '../lib/useAllSchemaObjects';
import { PermissionMatrix } from './PermissionMatrix';
import {
  DbAccessPermissionSections,
  type DbAccessConfirmRequest,
} from './DbAccessPermissionSections';
import type { DbPrincipal } from '@foxschema/sql';
import { sectionLabelCls } from '@/shared/components/surfaces';
import { writeClipboard } from '@/shared/utils/clipboard';

const PRESET_LABEL: Record<Exclude<AccessPreset, 'custom'>, string> = {
  'read-only': 'Read only',
  'read-write': 'Read and write',
  'application-writer': 'Application writer',
  'procedure-executor': 'Execute procedures',
  'schema-developer': 'Manage schema',
};

const CHANGE_STYLE = {
  grant: 'text-emerald-200 bg-emerald-500/10 border-emerald-500/30',
  revoke: 'text-rose-200 bg-rose-500/10 border-rose-500/30',
} as const;

/** "Grant SELECT, INSERT on public.orders, public.items" — one line per statement group. */
function changeLabel(action: 'grant' | 'revoke', req: PermissionRequest): string {
  const privileges = req.permissions.map((p) => p.replace(/-object$|-procedure$|-function$/, '').replace(/^read$/, 'select').toUpperCase()).join(', ');
  const { scope } = req;
  const where =
    scope.type === 'tables'
      ? scope.tables.map((t) => (scope.schema ? `${scope.schema}.${t}` : t)).join(', ')
      : scope.type === 'routines'
        ? scope.routines.map((r) => (scope.schema ? `${scope.schema}.${r.name}` : r.name)).join(', ')
        : 'schema' in scope
          ? scope.schema
          : scope.database;
  return `${action === 'grant' ? 'Grant' : 'Revoke'} ${privileges} on ${where}`;
}

export const AccessGrantsStage: React.FC<{
  dialect: string;
  connectionId: string;
  database?: string;
  defaultSchema?: string;
  principal: DbPrincipal;
  privileges: DbPrivilege[];
  canGrant: boolean;
  grantSupported: boolean;
  onConfirm: (req: DbAccessConfirmRequest) => void;
  onError: (msg: string) => void;
}> = ({
  dialect,
  connectionId,
  database,
  defaultSchema,
  principal,
  privileges,
  canGrant,
  grantSupported,
  onConfirm,
  onError,
}) => {
  const [activePreset, setActivePreset] = useState<AccessPreset | 'custom'>('custom');
  const [gridPreset, setGridPreset] = useState<{
    permissions: AccessPermission[];
    nonce: number;
  } | null>(null);
  const [changes, setChanges] = useState<GridChanges>({ grant: [], revoke: [] });
  const [resetNonce, setResetNonce] = useState<number | undefined>(undefined);
  const catalog = useAllSchemaObjects(connectionId, true);

  const accessPrincipal = useMemo(
    () => ({
      type: (principal.kind === 'user' ? 'user' : 'role') as 'user' | 'role',
      name: principal.name,
    }),
    [principal]
  );

  /**
   * What this principal holds on the grid's objects, so the grid opens on it,
   * and what else it holds, which the grid cannot show but must not hide.
   */
  const { held, elsewhere } = useMemo(
    () => splitHeldPrivileges(privileges, catalog.objects, dialect, defaultSchema || ''),
    [privileges, catalog.objects, dialect, defaultSchema]
  );
  const alsoHolds = useMemo(() => [...new Set(elsewhere.map(describeHeldPrivilege))], [elsewhere]);
  const onChanges = useCallback((next: GridChanges) => setChanges(next), []);

  const sqlText = useMemo(() => {
    const groups = [...changes.grant, ...changes.revoke];
    if (groups.length === 0) return '';
    return groups
      .map((r) => {
        const built = buildAccessSql({ ...r, principal: accessPrincipal }, dialect);
        if ('error' in built) return `-- ${built.error}`;
        return built.statements.map((st) => st.sql).join('\n');
      })
      .filter(Boolean)
      .join('\n\n');
  }, [changes, accessPrincipal, dialect]);

  const applyPreset = (preset: Exclude<AccessPreset, 'custom'>) => {
    setActivePreset(preset);
    setGridPreset((prev) => ({
      permissions: permissionsForPreset(preset),
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  };

  const openSql = () => {
    if (!sqlText.trim()) {
      onError(`Nothing to change: the grid matches what ${principal.name} holds now.`);
      return;
    }
    if (sqlText.split('\n').every((line) => line.trim().startsWith('--') || !line.trim())) {
      onError('No GRANT SQL for this selection.');
      return;
    }
    onConfirm({
      title: `GRANT SQL for ${principal.name}`,
      sql: sqlText,
      kind: 'grant',
    });
  };

  return (
    <div className="space-y-3" data-testid="access-grants-stage">
      <p className="text-[11px] text-slate-500">
        Fox Schema generates GRANT/REVOKE SQL — it does not apply it.
      </p>

      <div className="flex flex-wrap items-center gap-1.5" data-testid="access-grants-presets">
        <span className={sectionLabelCls}>
          Presets
        </span>
        {(Object.keys(PRESET_LABEL) as Exclude<AccessPreset, 'custom'>[]).map((p) => (
          <button
            key={p}
            type="button"
            data-testid={`access-grants-preset-${p}`}
            aria-pressed={activePreset === p}
            onClick={() => applyPreset(p)}
            className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition ${
              activePreset === p
                ? 'border-sky-500/50 bg-sky-500/15 text-sky-100'
                : 'border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            {PRESET_LABEL[p]}
          </button>
        ))}
        <button
          type="button"
          data-testid="access-grants-reset"
          title={`Put every box back to what ${principal.name} holds now`}
          onClick={() => {
            setActivePreset('custom');
            setResetNonce((n) => (n ?? 0) + 1);
          }}
          className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:text-slate-300"
        >
          Reset to current
        </button>
      </div>

      {catalog.loading && (
        <p className="text-[11px] text-slate-500">Reading schema objects…</p>
      )}

      <PermissionMatrix
        dialect={dialect}
        principal={accessPrincipal}
        action="grant"
        schema={defaultSchema || ''}
        catalog={catalog.objects}
        applyPreset={gridPreset}
        held={held}
        onChanges={onChanges}
        resetNonce={resetNonce}
      />

      {alsoHolds.length > 0 && (
        <p className="text-[11px] text-slate-400" data-testid="access-grants-also-holds">
          <span className="font-semibold text-slate-300">
            {principal.name} also holds, outside this grid:
          </span>{' '}
          {alsoHolds.join(' · ')}
        </p>
      )}

      {changes.grant.length + changes.revoke.length > 0 && (
        <ul className="space-y-1" data-testid="access-grants-diff">
          {[
            ...changes.grant.map((r) => ['grant', r] as const),
            ...changes.revoke.map((r) => ['revoke', r] as const),
          ].map(([action, r], i) => (
            <li
              key={i}
              data-testid={`access-grants-change-${action}`}
              className={`rounded border px-2 py-1 text-[11px] font-semibold ${CHANGE_STYLE[action]}`}
            >
              {changeLabel(action, r)}
            </li>
          ))}
        </ul>
      )}

      <div
        className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"
        data-testid="access-grants-sql"
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Grant SQL
          </h3>
          <div className="flex gap-1.5">
            <button
              type="button"
              data-testid="access-grants-copy"
              disabled={!sqlText.trim()}
              onClick={() => void writeClipboard(sqlText)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-1 text-[11px] font-bold text-slate-200 disabled:opacity-40"
            >
              <Copy className="w-3 h-3" /> Copy
            </button>
            <button
              type="button"
              data-testid="access-grants-open-sql"
              disabled={!sqlText.trim()}
              onClick={openSql}
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[11px] font-bold text-sky-100 disabled:opacity-40"
            >
              <FileCode2 className="w-3 h-3" /> Open in SQL Editor
            </button>
          </div>
        </div>
        <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {sqlText.trim() ||
            (catalog.loading
              ? 'Reading schema objects…'
              : `Nothing to change: the grid matches what ${principal.name} holds now. Tick a box to grant it, untick one to revoke it.`)}
        </pre>
        <p className="mt-2 text-[10px] text-slate-500">
          Fox Schema does not apply this SQL. The database stays the source of truth.
        </p>
      </div>
      {/*
        * Database- and schema-wide grants: a different scope from the
        * grid's rows, so a section of their own rather than a second
        * mode that redrew the same objects another way.
        */}
      <DbAccessPermissionSections
        dialect={dialect}
        connectionId={connectionId}
        database={database}
        defaultSchema={defaultSchema}
        principal={{ type: accessPrincipal.type, name: principal.name, kind: principal.kind }}
        privileges={privileges}
        canGrant={canGrant}
        grantSupported={grantSupported}
        generateOnly
        generalOnly
        onConfirm={onConfirm}
        onError={onError}
      />
    </div>
  );
};
