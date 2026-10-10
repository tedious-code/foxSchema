/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Side-by-side data migrate: key-based insert/update/delete onto a destination
 * grid (≤500 ops). Larger sets toast with Server Beam instructions.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, CheckCheck, Eye, History, Loader2, Shield, Undo2, X } from 'lucide-react';
import {
  apiExecuteDataMigrate,
  apiFinishDataMigrate,
  apiGetDataMigration,
  apiListDataMigrations,
  apiStartDataMigrate,
  type DataMigrateOpResult,
  type DataMigrateRunDetail,
  type DataMigrateRunSummary,
} from '@/features/sql-editor/api/dataMigrateApi';
import { buildDataMigratePlans, buildDestSnapshotJson, buildRestorePlansFromSnapshot, isUsableDataMigrateSnapshot, snapshotTargetConnectionId } from '@/features/sql-editor/lib/dataMigratePlans';
import {
  classifyRowsByKey,
  DATA_MIGRATE_ROW_CAP,
  diffKeyLabelsForOps,
  filterOpsByKeyLabels,
  migrateKeysSafeForMutatingOps,
  selectMigrateOps,
  type ClassifiedRowDiff,
} from '@/features/sql-editor/lib/resultRowDiff';
import { identityInsertFor } from '@foxschema/ui-shared';
import { assessPeekEditability, resolvePeekKeyColumns } from '@/features/sql-editor/lib/rowDml';
import { singleTableForResultEdit } from '@/shared/lib/tablePreview';
import type { TableSchema } from '@/shared/lib/types';
import { toast } from '@/app/store/toastStore';
import { useAuthStore } from '@/app/store/authStore';
import { useSqlEditorStore } from '@/features/sql-editor/state/useSqlEditorStore';
import { useSyncStore } from '@/features/compare';
import { SQL_ICON_STROKE } from '@/shared/lib/iconStyle';
import { dialectLabel } from '@/shared/lib/dialectLabel';

export interface DataMigrateGrid {
  connectionId: string;
  dialect: string;
  label: string;
  columns: string[];
  rows: unknown[][];
  statementSql?: string;
  /** 0-based page currently shown in the result grid. */
  pageIndex?: number;
  /** True when more rows exist beyond this page (hasNext / truncated). */
  hasMore?: boolean;
}

type ProgressItem = {
  keyLabel: string;
  op: ClassifiedRowDiff['op'];
  status: 'pending' | 'running' | 'ok' | 'fail' | 'skipped';
  error?: string;
};

interface Props {
  statementIndex: number;
  source: DataMigrateGrid;
  dest: DataMigrateGrid;
  /** Trigger/audit columns excluded from UPDATE detection and INSERT/UPDATE SET. */
  ignoreColumns?: string[];
  /** Controlled key columns (shared with Compare alignment). */
  keyNames?: string[];
  onKeyNamesChange?: (names: string[]) => void;
  /** Row Sync checkboxes — which differing keys to include in migrate. */
  selectedSyncKeys?: ReadonlySet<string>;
  onSelectedSyncKeysChange?: (keys: Set<string>) => void;
  onAfterMigrate?: () => void;
  onOpenServerBeamSample?: () => void;
}

export const DataMigrateBar: React.FC<Props> = ({
  statementIndex,
  source,
  dest,
  ignoreColumns = [],
  keyNames: keyNamesProp = [],
  onKeyNamesChange,
  selectedSyncKeys = new Set(),
  onSelectedSyncKeysChange,
  onAfterMigrate,
  onOpenServerBeamSample,
}) => {
  const canDml = useAuthStore((s) => s.can('editor.dml'));
  const sessionPasswords = useSqlEditorStore((s) => s.sessionPasswords);
  const safeMode = useSqlEditorStore((s) => s.safeMode);
  const schemaCache = useSqlEditorStore((s) => s.schemaCache);
  const ensureSchema = useSqlEditorStore((s) => s.ensureSchema);
  const connections = useSyncStore((s) => s.connections);
  const destConn = connections.find((c) => c.id === dest.connectionId);
  const sourceConn = connections.find((c) => c.id === source.connectionId);
  // Which engine each grid came from. Worth showing at all times, and worth
  // calling out when they differ: the destination is what governs the write.
  const sourceProvider = dialectLabel(source.dialect);
  const destProvider = dialectLabel(dest.dialect);
  const crossDialect = source.dialect.toLowerCase() !== dest.dialect.toLowerCase();
  const destSchema = destConn?.schema;
  const tables = schemaCache[dest.connectionId]?.tables;

  // Data migrate needs the destination table list; warm it lazily when the bar mounts.
  useEffect(() => {
    if (!dest.connectionId) return;
    const entry = useSqlEditorStore.getState().schemaCache[dest.connectionId];
    if (entry?.status === 'ready' || entry?.status === 'loading') return;
    void ensureSchema(dest.connectionId);
  }, [dest.connectionId, ensureSchema]);

  const editTarget = useMemo(() => {
    if (!source.statementSql) return { ok: false as const, reason: 'No statement SQL' };
    return singleTableForResultEdit(source.statementSql, tables, destSchema);
  }, [source.statementSql, tables, destSchema]);

  const table: TableSchema | undefined = editTarget.ok ? editTarget.table : undefined;
  const tableName = table?.name ?? '';

  const preferredKeyNames = useMemo(
    () =>
      resolvePeekKeyColumns(table, source.columns)
        .filter((k) => k.resultIndex >= 0)
        .map((k) => k.name),
    [table, source.columns]
  );

  const sharedColumns = useMemo(() => {
    const destLower = new Set(dest.columns.map((c) => c.toLowerCase()));
    return source.columns.filter((c) => destLower.has(c.toLowerCase()));
  }, [source.columns, dest.columns]);

  const keyNames = keyNamesProp;

  const toggleKeyColumn = (col: string) => {
    if (!onKeyNamesChange) return;
    const lower = col.toLowerCase();
    const has = keyNames.some((k) => k.toLowerCase() === lower);
    if (has) {
      const next = keyNames.filter((k) => k.toLowerCase() !== lower);
      if (next.length === 0) return;
      onKeyNamesChange(next);
    } else {
      onKeyNamesChange([...keyNames, col]);
    }
  };

  /** Ops default on when that op has rows — Sync alone can enable Migrate. */
  const [doInsert, setDoInsert] = useState(true);
  const [doUpdate, setDoUpdate] = useState(true);
  const [doDelete, setDoDelete] = useState(true);
  const [includeIdentity, setIncludeIdentity] = useState(false);
  /** Safety: one transaction for the whole batch (Stop mode). Off with Continue = per-op commits. */
  const [useTransaction, setUseTransaction] = useState(true);
  /** Safety: Continue = skip failures; Stop = abort (rollback if transaction on). */
  const [continueOnError, setContinueOnError] = useState(false);
  /**
   * Safety: capture a pre-apply dest snapshot so successful ops can be reversed
   * when a batch fails without a real transaction rollback (Continue mode,
   * Transaction off, Redis/Mongo/ClickHouse).
   */
  const [backupEnabled, setBackupEnabled] = useState(true);
  const [lastBackup, setLastBackup] = useState<{
    runId: string | null;
    /** Destination that was migrated — Restore must not follow a later Destination switch. */
    connectionId: string;
    snapshotJson: string;
    results: DataMigrateOpResult[];
    tableName: string;
    dialect: string;
  } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<ProgressItem[] | null>(null);
  const [failedSummary, setFailedSummary] = useState<DataMigrateOpResult[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<DataMigrateRunSummary[]>([]);
  const [historyDetail, setHistoryDetail] = useState<DataMigrateRunDetail | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSql, setPreviewSql] = useState('');
  const [safeConfirmOpen, setSafeConfirmOpen] = useState(false);

  const editability = useMemo(
    () => assessPeekEditability({ dialect: dest.dialect, table, resultColumns: source.columns }),
    [dest.dialect, table, source.columns]
  );

  /** Declaration of the destination identity column, for the INSERT shape. */
  const identityGenerationForTable = useMemo(() => {
    const col = table?.columns.find((c) => editability.identityColumns.has(c.name));
    return col?.identityGeneration;
  }, [table, editability.identityColumns]);

  const classification = useMemo(
    () =>
      classifyRowsByKey({
        source: { columns: source.columns, rows: source.rows },
        dest: { columns: dest.columns, rows: dest.rows },
        keyNames,
        ignoreColumns,
        // A row missing from a partial grid may just be on a later page: count
        // it as unresolved rather than offer an INSERT/DELETE for it.
        sourceComplete: (source.pageIndex ?? 0) === 0 && !source.hasMore,
        destComplete: (dest.pageIndex ?? 0) === 0 && !dest.hasMore,
      }),
    [
      source.columns,
      source.rows,
      dest.columns,
      dest.rows,
      keyNames,
      ignoreColumns,
      source.pageIndex,
      source.hasMore,
      dest.pageIndex,
      dest.hasMore,
    ]
  );

  const opsEnabled = useMemo(
    () => ({ insert: doInsert, update: doUpdate, delete: doDelete }),
    [doInsert, doUpdate, doDelete]
  );

  /** Sync checkboxes track enabled Ops — uncheck Add/Edit/Delete clears those Sync rows. */
  const enabledSyncLabelsKey = useMemo(
    () => diffKeyLabelsForOps(classification, opsEnabled).join('\0'),
    [classification, opsEnabled]
  );

  useEffect(() => {
    if (!onSelectedSyncKeysChange) return;
    const labels = enabledSyncLabelsKey
      ? enabledSyncLabelsKey.split('\0').filter(Boolean)
      : [];
    onSelectedSyncKeysChange(new Set(labels));
  }, [enabledSyncLabelsKey, onSelectedSyncKeysChange]);

  const selected = useMemo(
    () => selectMigrateOps(classification, opsEnabled),
    [classification, opsEnabled]
  );

  const filtered = useMemo(
    () => filterOpsByKeyLabels(selected.ops, selectedSyncKeys, DATA_MIGRATE_ROW_CAP),
    [selected.ops, selectedSyncKeys]
  );

  const syncAll = () => {
    if (!onSelectedSyncKeysChange) return;
    onSelectedSyncKeysChange(new Set(diffKeyLabelsForOps(classification, opsEnabled)));
  };

  const buildPreviewSql = (): string | null => {
    if (!editTarget.ok || !table || !tableName) return null;
    const { plans, errors } = buildDataMigratePlans({
      tableName,
      dialect: dest.dialect,
      sourceColumns: source.columns,
      destColumns: dest.columns,
      keyNames,
      ops: filtered.ops,
      includeIdentity,
      identityColumns: editability.identityColumns,
      identityGeneration: identityGenerationForTable,
      ignoreColumns,
    });
    if (plans.length === 0) {
      return errors[0] ?? 'No SQL for the current Sync selection.';
    }
    const body = plans
      .slice(0, 40)
      .map((p) => `-- ${p.op.toUpperCase()} ${p.keyLabel}\n${p.plan.displaySql || p.plan.sql}`)
      .join('\n\n');
    const more =
      plans.length > 40 ? `\n\n-- … and ${plans.length - 40} more statement(s)` : '';
    return body + more;
  };

  const openPreview = () => {
    const text = buildPreviewSql();
    if (!text) {
      toast({
        tone: 'info',
        title: 'Nothing to preview',
        body: 'Pick Keys, enable Ops, and Sync rows first.',
      });
      return;
    }
    setPreviewSql(text);
    setPreviewOpen(true);
  };

  const requestApply = () => {
    if (safeMode) {
      setSafeConfirmOpen(true);
      return;
    }
    void apply();
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    try {
      const runs = await apiListDataMigrations();
      setHistoryRuns(runs);
      if (runs[0]) {
        setHistoryDetail(await apiGetDataMigration(runs[0].id));
      } else {
        setHistoryDetail(null);
      }
    } catch (e) {
      toast({
        tone: 'warning',
        title: 'Could not load data migrate history',
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const apply = async () => {
    if (applying || !canDml) return;
    if (!editTarget.ok || !table) {
      toast({
        tone: 'warning',
        title: 'Data migrate needs a single-table SELECT',
        body: editTarget.ok ? 'Table not found in schema cache.' : editTarget.reason,
      });
      return;
    }
    if (keyNames.length === 0) {
      toast({
        tone: 'warning',
        title: 'Pick at least one Key column',
        body: 'Check a shared column under Keys (for example ATTRIBUTENAME) so rows can match.',
      });
      return;
    }
    const keysMissing = keyNames.filter(
      (k) =>
        !source.columns.some((c) => c.toLowerCase() === k.toLowerCase()) ||
        !dest.columns.some((c) => c.toLowerCase() === k.toLowerCase())
    );
    if (keysMissing.length > 0) {
      toast({
        tone: 'warning',
        title: 'Key columns missing from the result',
        body: `Include ${keysMissing.join(', ')} in the SELECT, or pick a Key that is in both grids.`,
      });
      return;
    }
    if (selected.uncappedCount === 0) {
      toast({ tone: 'info', title: 'Nothing to migrate', body: 'Grids match for the selected ops.' });
      return;
    }
    if (filtered.uncappedCount === 0) {
      toast({
        tone: 'warning',
        title: 'No rows selected for Sync',
        body:
          'You chose Add / Edit / Delete but no differing rows are checked. ' +
          'Use the Sync column on the destination grid or click Sync all.',
      });
      return;
    }
    if (classification.duplicateKeys > 0) {
      toast({
        tone: 'warning',
        title: 'Duplicate keys in result grids',
        body:
          `${classification.duplicateKeys} duplicate key value(s) — migrate refuses to guess which row to write. ` +
          'Tighten the SELECT (DISTINCT / better keys) or pick a unique key set.',
      });
      return;
    }
    // Name Keys may align Sync / Add-only migrate, but UPDATE/DELETE WHERE on a
    // non-unique column can rewrite or delete every matching destination row.
    const keySafety = migrateKeysSafeForMutatingOps({
      keyNames,
      uniqueKeyNames: editability.keyColumns
        .filter((k) => k.resultIndex >= 0)
        .map((k) => k.name),
      editable: editability.editable,
      ops: filtered.ops,
    });
    if (!keySafety.ok) {
      toast({ tone: 'warning', title: keySafety.title, body: keySafety.body });
      return;
    }
    if (filtered.uncappedCount > DATA_MIGRATE_ROW_CAP) {
      toast({
        tone: 'warning',
        title: `Over ${DATA_MIGRATE_ROW_CAP} row ops — use Server Beam`,
        body:
          `This compare has ${filtered.uncappedCount} insert/update/delete ops. ` +
          `Side-by-side migrate is limited to ${DATA_MIGRATE_ROW_CAP} rows. ` +
          'Check source then target Destinations, turn Safe mode off, and run the ' +
          'Server Beam chunked sample (Bookmarks → Add samples).',
        actionButtonLabel: 'Insert Server Beam sample',
        onAction: onOpenServerBeamSample,
        durationMs: 14_000,
      });
      return;
    }

    // Include identity writes the source id explicitly, which most engines
    // refuse unless the statement or session is shaped for it. Decide here,
    // from the destination dialect and how the column was declared, so the user
    // gets a sentence instead of Msg 544 / ORA-32795 / SQL0798N mid-run.
    //
    // The destination decides, not the source: every statement runs there, so a
    // Postgres → SQL Server migrate is governed by SQL Server's rules.
    let identityInsertTable: string | undefined;
    if (includeIdentity && filtered.ops.some((o) => o.op === 'insert')) {
      const generations = new Set(
        (tables ?? [])
          .find((t) => t.name === tableName)
          ?.columns.filter((c) => editability.identityColumns.has(c.name))
          .map((c) => c.identityGeneration) ?? []
      );
      const supports = [...(generations.size ? generations : [undefined])].map((g) =>
        identityInsertFor(dest.dialect, g)
      );

      // Nothing shapes an insert the engine will not take at all.
      const blocked = supports.find((s) => s.kind === 'unsupported');
      if (blocked) {
        toast({
          tone: 'warning',
          title: 'Include identity is not supported here',
          body:
            blocked.reason ??
            `${dest.dialect} cannot take an explicit identity value. Turn off Include identity to let the destination assign ids.`,
          durationMs: 12_000,
        });
        return;
      }

      // SQL Server and Azure SQL gate it on the session instead. The server
      // issues SET IDENTITY_INSERT ON before the ops and OFF after, on the same
      // connection; all it needs from here is the table.
      if (supports.some((s) => s.kind === 'toggle')) {
        identityInsertTable = tableName;
      }

      // Where a sequence backs the column, writing an id explicitly does not
      // advance it, so the destination will hand out ids that already exist.
      // The migration itself succeeds, which is what makes it worth saying.
      if (supports.some((s) => s.resyncSequence)) {
        toast({
          tone: 'warning',
          title: 'Reset the identity sequence after this migrate',
          body:
            `${dest.dialect} keeps its sequence where it was when an id is written ` +
            'explicitly, so the next generated id will collide with a row this ' +
            'migrate inserted. Advance the sequence past the highest id once it finishes.',
          durationMs: 14_000,
        });
      }
    }

    // Columns the source SELECT returns that the destination table does not
    // have. INSERT/UPDATE name them, so the op fails at the database with a
    // bare "column does not exist" — after the user has clicked Sync. The
    // information to say so upfront is already computed (editableColumns is the
    // dest table ∩ source result), it just was not being read. Most likely when
    // comparing across dialects, where the two schemas have drifted.
    if (filtered.ops.some((o) => o.op === 'insert' || o.op === 'update')) {
      const writable = new Set(editability.editableColumns.map((c) => c.toLowerCase()));
      const ignored = new Set(ignoreColumns.map((c) => c.toLowerCase()));
      const unknown = source.columns.filter(
        (c) => !writable.has(c.toLowerCase()) && !ignored.has(c.toLowerCase())
      );
      if (unknown.length > 0) {
        toast({
          tone: 'warning',
          title: `${unknown.length} column(s) not in the destination table`,
          body:
            `${unknown.slice(0, 6).join(', ')}${unknown.length > 6 ? ', …' : ''} — ` +
            'Add / Edit would write columns the destination does not have. ' +
            'Drop them from the source SELECT, or list them under Ignore columns.',
        });
        return;
      }
    }

    // Rows whose key is NULL are dropped from the comparison entirely — they
    // cannot identify a row to UPDATE or DELETE. Say so: otherwise the op counts
    // silently understate the difference and the user believes they synced
    // everything. Not a blocker, since the rows that DO have keys migrate fine.
    if (classification.skippedNullKeys > 0) {
      toast({
        tone: 'warning',
        title: `${classification.skippedNullKeys} row(s) skipped — NULL key`,
        body:
          'A NULL key cannot identify a row to write, so these rows are not in the ' +
          'counts above and will not migrate. Pick a key set with no NULLs, or filter ' +
          'them out in the SELECT.',
      });
    }

    const { plans, errors } = buildDataMigratePlans({
      tableName,
      dialect: dest.dialect,
      sourceColumns: source.columns,
      destColumns: dest.columns,
      keyNames,
      ops: filtered.ops,
      includeIdentity,
      identityColumns: editability.identityColumns,
      identityGeneration: identityGenerationForTable,
      ignoreColumns,
    });
    if (errors.length) {
      toast({
        tone: 'warning',
        title: 'Some plans could not be built',
        body: errors.slice(0, 3).join(' · '),
      });
    }
    if (plans.length === 0) return;

    const snapshotJson = backupEnabled
      ? buildDestSnapshotJson({
          tableName,
          dialect: dest.dialect,
          connectionId: dest.connectionId,
          destColumns: dest.columns,
          sourceColumns: source.columns,
          keyNames,
          includeIdentity,
          ops: filtered.ops,
        })
      : undefined;
    const script = [
      `-- useTransaction=${useTransaction} continueOnError=${continueOnError} backup=${backupEnabled}`,
      ...plans.map((p) => `-- ${p.op} ${p.keyLabel}\n${p.plan.displaySql};`),
    ].join('\n\n');

    setApplying(true);
    setFailedSummary([]);
    setProgress(
      plans.map((p) => ({
        keyLabel: p.keyLabel,
        op: p.op,
        status: 'pending' as const,
      }))
    );

    let runId: string | null = null;
    let snapshotStored = false;
    try {
      const started = await apiStartDataMigrate({
        dialect: dest.dialect,
        sourceHost: sourceConn?.host || source.label,
        targetHost: destConn?.host || dest.label,
        database: destConn?.database,
        schema: destConn?.schema,
        tableName,
        rowCount: plans.length,
        opsEnabled: { insert: doInsert, update: doUpdate, delete: doDelete },
        includeIdentity,
        keyColumns: keyNames,
        script,
        snapshotJson,
      });
      runId = started.id;
      snapshotStored = started.snapshotStored;
      if (backupEnabled && snapshotJson && !snapshotStored) {
        toast({
          tone: 'warning',
          title: 'Backup too large for History',
          body: 'The pre-apply snapshot exceeds the 1MB History limit, so durable Restore after reload is unavailable. Use Restore from the toast while this session still has the in-memory backup.',
        });
      }
    } catch (e) {
      toast({
        tone: 'warning',
        title: 'Could not start history record',
        body: e instanceof Error ? e.message : String(e),
      });
    }

    let results: DataMigrateOpResult[] = [];
    let failCount = 0;
    let rolledBack = false;

    try {
      setProgress((prev) => prev?.map((p) => ({ ...p, status: 'running' })) ?? prev);
      const out = await apiExecuteDataMigrate(
        {
          connectionId: dest.connectionId,
          password: sessionPasswords[dest.connectionId] || undefined,
          schema: destConn?.schema?.trim() || undefined,
        },
        plans.map((p) => ({
          op: p.op,
          key: p.keyLabel,
          sql: p.plan.sql,
          params: p.plan.params,
        })),
        { useTransaction, continueOnError, identityInsertTable }
      );
      results = out.results;
      failCount = out.failCount;
      rolledBack = out.rolledBack;
      setProgress(
        results.map((r) => ({
          keyLabel: r.key,
          op: r.op,
          status:
            r.status === 'SUCCESS' ? 'ok' : r.status === 'SKIPPED' ? 'skipped' : 'fail',
          error: r.error,
        }))
      );
      setFailedSummary(results.filter((r) => r.status === 'FAILED'));
    } catch (e) {
      failCount = plans.length;
      const msg = e instanceof Error ? e.message : String(e);
      results = plans.map((p) => ({
        op: p.op,
        key: p.keyLabel,
        status: 'FAILED' as const,
        error: msg,
      }));
      setProgress(
        plans.map((p) => ({
          keyLabel: p.keyLabel,
          op: p.op,
          status: 'fail' as const,
          error: msg,
        }))
      );
      setFailedSummary(results);
    }

    const status =
      failCount === 0
        ? 'SUCCESS'
        : failCount === plans.length || rolledBack
          ? 'FAILED'
          : 'PARTIAL_SUCCESS';
    if (runId) {
      try {
        await apiFinishDataMigrate(runId, { status, results });
      } catch {
        /* history best-effort */
      }
    }

    setApplying(false);

    const succeeded = results.filter((r) => r.status === 'SUCCESS');
    const canOfferRestore =
      backupEnabled &&
      Boolean(snapshotJson) &&
      failCount > 0 &&
      !rolledBack &&
      succeeded.length > 0;

    // Capture at apply time — toast onAction must not read a later Destination switch.
    const migratedConnectionId = dest.connectionId;
    const migratedDialect = dest.dialect;
    const migratedLabel = dest.label;

    if (canOfferRestore && snapshotJson) {
      setLastBackup({
        runId,
        connectionId: migratedConnectionId,
        snapshotJson,
        results,
        tableName,
        dialect: migratedDialect,
      });
    } else {
      setLastBackup(null);
    }

    const failedKeys = results
      .filter((r) => r.status === 'FAILED')
      .map((r) => `${r.op} ${r.key}`)
      .slice(0, 5);
    toast({
      tone: failCount === 0 ? 'success' : 'warning',
      title:
        failCount === 0
          ? `Migrated ${plans.length} row ops`
          : rolledBack
            ? `Rolled back — ${failCount} failure(s)`
            : `Finished with ${failCount} failure(s)`,
      body:
        failCount === 0
          ? `Destination: ${migratedLabel}.${
              backupEnabled
                ? snapshotStored
                  ? ' Backup snapshot saved to history.'
                  : ' Backup kept in-session only (too large for History).'
                : ''
            }`
          : `Failed: ${failedKeys.join('; ')}${
              results.filter((r) => r.status === 'FAILED').length > 5 ? '…' : ''
            }. ${rolledBack ? 'Transaction rolled back. ' : ''}${
              canOfferRestore ? 'Backup is ready — Restore reverses successful ops. ' : ''
            }See progress / history.`,
      actionButtonLabel: canOfferRestore ? 'Restore backup' : 'View history',
      onAction: canOfferRestore
        ? () =>
            void restoreFromBackup({
              runId,
              connectionId: migratedConnectionId,
              snapshotJson: snapshotJson!,
              results,
              tableName,
              dialect: migratedDialect,
            })
        : () => void openHistory(),
      durationMs: 12_000,
    });
    if (!rolledBack) await onAfterMigrate?.();
  };

  const restoreFromBackup = async (backup: {
    runId: string | null;
    connectionId: string;
    snapshotJson: string;
    results: DataMigrateOpResult[];
    tableName: string;
    dialect: string;
  }) => {
    if (restoring || applying) return;
    const successfulOps = backup.results
      .filter((r) => r.status === 'SUCCESS')
      .map((r) => ({ op: r.op, key: r.key }));
    if (successfulOps.length === 0) {
      toast({ tone: 'info', title: 'Nothing to restore', body: 'No successful ops in that run.' });
      return;
    }

    // Prefer the connection recorded at migrate time (snapshot / caller). Never
    // silently follow a later Compare Destination switch — that would reverse
    // DML onto the wrong database (same failure class as Lokee #256).
    const targetConnectionId =
      backup.connectionId.trim() ||
      snapshotTargetConnectionId(backup.snapshotJson) ||
      '';
    if (!targetConnectionId) {
      toast({
        tone: 'warning',
        title: 'Cannot restore',
        body: 'This backup does not record which destination was migrated. Re-run migrate with Backup on, or restore only while the original Destination is selected.',
      });
      return;
    }
    const targetConn = connections.find((c) => c.id === targetConnectionId);
    if (!targetConn) {
      toast({
        tone: 'warning',
        title: 'Cannot restore',
        body: 'The destination credential for this backup is no longer available.',
      });
      return;
    }

    const { plans, errors } = buildRestorePlansFromSnapshot({
      snapshotJson: backup.snapshotJson,
      successfulOps,
      tableName: backup.tableName,
      dialect: backup.dialect,
    });
    if (errors.length) {
      toast({
        tone: 'warning',
        title: 'Could not build full restore',
        body: errors.slice(0, 3).join(' · '),
      });
    }
    if (plans.length === 0) return;

    setRestoring(true);
    setProgress(
      plans.map((p) => ({
        keyLabel: p.keyLabel,
        op: p.op,
        status: 'running' as const,
      }))
    );

    let restoreRunId: string | null = null;
    try {
      const started = await apiStartDataMigrate({
        dialect: backup.dialect,
        sourceHost: 'backup-restore',
        targetHost: targetConn.host || targetConn.name || targetConnectionId,
        database: targetConn.database,
        schema: targetConn.schema,
        tableName: backup.tableName,
        rowCount: plans.length,
        opsEnabled: { insert: true, update: true, delete: true },
        includeIdentity: true,
        keyColumns: keyNames,
        script: [
          `-- restore from backup of run ${backup.runId ?? 'n/a'}`,
          ...plans.map((p) => `-- ${p.op} ${p.keyLabel}\n${p.plan.displaySql};`),
        ].join('\n\n'),
        snapshotJson: backup.snapshotJson,
      });
      restoreRunId = started.id;
    } catch {
      /* history best-effort */
    }

    try {
      const out = await apiExecuteDataMigrate(
        {
          connectionId: targetConnectionId,
          password: sessionPasswords[targetConnectionId] || undefined,
          schema: targetConn.schema?.trim() || undefined,
        },
        plans.map((p) => ({
          op: p.op,
          key: p.keyLabel,
          sql: p.plan.sql,
          params: p.plan.params,
        })),
        { useTransaction: true, continueOnError: false }
      );
      setProgress(
        out.results.map((r) => ({
          keyLabel: r.key,
          op: r.op,
          status:
            r.status === 'SUCCESS' ? 'ok' : r.status === 'SKIPPED' ? 'skipped' : 'fail',
          error: r.error,
        }))
      );
      if (restoreRunId) {
        await apiFinishDataMigrate(restoreRunId, {
          status:
            out.failCount === 0
              ? 'SUCCESS'
              : out.rolledBack
                ? 'FAILED'
                : 'PARTIAL_SUCCESS',
          results: out.results,
        }).catch(() => undefined);
      }
      toast({
        tone: out.failCount === 0 ? 'success' : 'warning',
        title:
          out.failCount === 0
            ? out.rolledBack
              ? 'Restore rolled back'
              : `Restored ${out.results.filter((r) => r.status === 'SUCCESS').length} ops`
            : `Restore finished with ${out.failCount} failure(s)`,
        body: out.rolledBack
          ? 'Transaction rolled back — destination unchanged by restore.'
          : 'Reversed successful migrate ops from the Backup snapshot.',
      });
      if (out.failCount === 0) setLastBackup(null);
      if (!out.rolledBack) await onAfterMigrate?.();
    } catch (e) {
      toast({
        tone: 'warning',
        title: 'Restore failed',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRestoring(false);
    }
  };

  if (!canCompareReady(source, dest)) return null;

  const migrateCount = filtered.uncappedCount;
  const overCap = migrateCount > DATA_MIGRATE_ROW_CAP;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-sky-500/40 bg-gradient-to-br from-slate-950/90 via-slate-900/80 to-sky-950/40 px-3 py-2.5 shadow-sm shadow-sky-500/10"
      data-testid={`sql-data-migrate-bar-${statementIndex}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs font-bold text-slate-300">
        <span className="inline-flex items-center gap-1.5 text-sky-300">
          <ArrowRightLeft className="w-4 h-4" strokeWidth={SQL_ICON_STROKE} />
          Data migrate
        </span>
        <span
          className="text-slate-400 truncate max-w-[24rem] font-semibold"
          title={`${source.label} (${sourceProvider}) → ${dest.label} (${destProvider})`}
          data-testid={`sql-data-migrate-route-${statementIndex}`}
        >
          {source.label}{' '}
          <span className="text-slate-500 font-medium">({sourceProvider})</span> →{' '}
          {dest.label} <span className="text-slate-500 font-medium">({destProvider})</span>
        </span>
        {crossDialect ? (
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-amber-500/15 text-amber-300"
            title={
              `Every statement runs on the destination, so ${destProvider} decides what is ` +
              'allowed — identity handling, type limits and quoting all follow it, not the source.'
            }
          >
            cross-dialect
          </span>
        ) : null}
        <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
          <span
            className="rounded-md border border-emerald-500/40 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-200"
            data-testid={`sql-data-migrate-chip-add-${statementIndex}`}
          >
            {classification.inserts.length} add
          </span>
          <span
            className="rounded-md border border-amber-500/40 bg-amber-950/40 px-1.5 py-0.5 text-amber-200"
            data-testid={`sql-data-migrate-chip-edit-${statementIndex}`}
          >
            {classification.updates.length} edit
          </span>
          <span
            className="rounded-md border border-rose-500/40 bg-rose-950/40 px-1.5 py-0.5 text-rose-200"
            data-testid={`sql-data-migrate-chip-delete-${statementIndex}`}
          >
            {classification.deletes.length} delete
          </span>
          {selected.uncappedCount > migrateCount ? (
            <span className="text-slate-500">{migrateCount} synced</span>
          ) : null}
          {overCap ? (
            <span className="text-amber-300">capped {DATA_MIGRATE_ROW_CAP}</span>
          ) : null}
        </span>
        <button
          type="button"
          data-testid={`sql-data-migrate-history-${statementIndex}`}
          onClick={() => void openHistory()}
          className="inline-flex items-center gap-1 text-slate-500 hover:text-cyan-400 font-semibold text-[11px]"
        >
          <History className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} /> History
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] font-semibold text-slate-400">
        <span className="text-sky-400/90 shrink-0">Keys</span>
        {sharedColumns.length > 0 ? (
          sharedColumns.map((col) => {
            const checked = keyNames.some((k) => k.toLowerCase() === col.toLowerCase());
            const preferred = preferredKeyNames.some((k) => k.toLowerCase() === col.toLowerCase());
            return (
              <label
                key={col}
                className={`inline-flex items-center gap-1 cursor-pointer select-none rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                  checked
                    ? 'border-sky-500/50 bg-sky-950/60 text-sky-200'
                    : 'border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-600'
                }`}
                title={
                  preferred
                    ? 'Primary key / unique index column (recommended)'
                    : 'Shared column — check to align and match rows'
                }
              >
                <input
                  type="checkbox"
                  data-testid={`sql-data-migrate-key-${col}-${statementIndex}`}
                  checked={checked}
                  onChange={() => toggleKeyColumn(col)}
                  className="rounded border-slate-600 accent-sky-500"
                />
                {col}
                {preferred ? (
                  <span className="text-[9px] uppercase tracking-wide text-emerald-400/90">pk</span>
                ) : null}
              </label>
            );
          })
        ) : (
          <span className="text-amber-400/90">
            No shared columns between source and destination grids.
          </span>
        )}
        {keyNames.length === 0 && sharedColumns.length > 0 && (
          <span className="text-amber-400/90">Pick at least one key column.</span>
        )}
        {preferredKeyNames.length === 0 && sharedColumns.length > 0 && (
          <span className="text-amber-400/90 text-[10px]">
            No PK in this SELECT — check a Key (e.g. {sharedColumns[0]}) to align Sync.
            Add-only migrate is allowed; Edit/Delete need the unique key in the SELECT.
          </span>
        )}
        {preferredKeyNames.length === 0 && sharedColumns.length === 0 && editability.reason && (
          <span className="text-amber-400/90 text-[10px]">{editability.reason}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] font-semibold text-slate-400">
        <span className="text-sky-400/90 shrink-0" title="Choose which row ops to apply — nothing runs until you check an op.">
          Ops
        </span>
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none rounded-md border border-emerald-500/40 bg-emerald-950/40 px-2 py-0.5 text-emerald-200">
          <input
            type="checkbox"
            data-testid={`sql-data-migrate-insert-${statementIndex}`}
            checked={doInsert}
            onChange={(e) => setDoInsert(e.target.checked)}
            className="rounded border-emerald-600 accent-emerald-500"
          />
          Add ({classification.inserts.length})
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none rounded-md border border-amber-500/40 bg-amber-950/40 px-2 py-0.5 text-amber-200">
          <input
            type="checkbox"
            data-testid={`sql-data-migrate-update-${statementIndex}`}
            checked={doUpdate}
            onChange={(e) => setDoUpdate(e.target.checked)}
            className="rounded border-amber-600 accent-amber-500"
          />
          Edit ({classification.updates.length})
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none rounded-md border border-rose-500/40 bg-rose-950/40 px-2 py-0.5 text-rose-200">
          <input
            type="checkbox"
            data-testid={`sql-data-migrate-delete-${statementIndex}`}
            checked={doDelete}
            onChange={(e) => setDoDelete(e.target.checked)}
            className="rounded border-rose-600 accent-rose-500"
          />
          Delete ({classification.deletes.length})
        </label>
        <button
          type="button"
          data-testid={`sql-data-migrate-sync-all-${statementIndex}`}
          onClick={syncAll}
          className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-950/50 px-2 py-0.5 text-sky-200 hover:bg-sky-900/60"
          title="Re-check Sync for rows matching the enabled Add / Edit / Delete ops"
        >
          <CheckCheck className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
          Sync all
        </button>
        <label
          className="inline-flex items-center gap-1 cursor-pointer select-none text-slate-500"
          title="When on, Add includes identity/autoincrement values from the source (preserve IDs). When off, the destination generates them."
        >
          <input
            type="checkbox"
            data-testid={`sql-data-migrate-identity-${statementIndex}`}
            checked={includeIdentity}
            onChange={(e) => setIncludeIdentity(e.target.checked)}
            className="rounded border-slate-600"
          />
          Include identity / IDs
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-slate-400">
        <span
          className="text-sky-400/90 shrink-0"
          title="Safety assists — you choose the ops; we help contain failures."
        >
          Safety
        </span>
        <label
          className="inline-flex items-center gap-1 cursor-pointer select-none"
          title="Wrap all ops in one transaction when Stop is selected. With Continue, each op uses its own transaction so a failure only rolls back that row."
        >
          <input
            type="checkbox"
            data-testid={`sql-data-migrate-tx-${statementIndex}`}
            checked={useTransaction}
            onChange={(e) => setUseTransaction(e.target.checked)}
            className="rounded border-slate-600"
          />
          Transaction
        </label>
        <label
          className="inline-flex items-center gap-1 cursor-pointer select-none"
          title="Continue: keep applying after a failed row. Stop: abort (and roll back the whole batch when Transaction is on)."
        >
          <input
            type="checkbox"
            data-testid={`sql-data-migrate-continue-${statementIndex}`}
            checked={continueOnError}
            onChange={(e) => setContinueOnError(e.target.checked)}
            className="rounded border-slate-600"
          />
          {continueOnError ? 'Continue on error' : 'Stop on error'}
        </label>
        <label
          className="inline-flex items-center gap-1 cursor-pointer select-none text-emerald-300/90"
          title="Before applying, snapshot destination rows (and insert keys). If a batch fails without a transaction rollback, Restore reverses the successful ops — like a safe mode for Compare Data."
        >
          <input
            type="checkbox"
            data-testid={`sql-data-migrate-backup-${statementIndex}`}
            checked={backupEnabled}
            onChange={(e) => setBackupEnabled(e.target.checked)}
            className="rounded border-slate-600"
          />
          <Shield className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
          Backup
        </label>
        {lastBackup && (
          <button
            type="button"
            data-testid={`sql-data-migrate-restore-${statementIndex}`}
            disabled={restoring || applying}
            onClick={() => void restoreFromBackup(lastBackup)}
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-950/40 px-2 py-0.5 text-amber-200 hover:bg-amber-900/50 disabled:opacity-40"
            title="Reverse successful ops from the last Backup snapshot"
          >
            {restoring ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} />
            ) : (
              <Undo2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
            )}
            Restore backup
          </button>
        )}
        <button
          type="button"
          data-testid={`sql-data-migrate-preview-${statementIndex}`}
          disabled={
            applying ||
            restoring ||
            !canDml ||
            selected.uncappedCount === 0 ||
            migrateCount === 0
          }
          onClick={openPreview}
          className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-900/70 px-2 py-0.5 text-slate-200 hover:border-sky-500/40 hover:text-sky-100 disabled:opacity-40"
          title="Preview the INSERT / UPDATE / DELETE SQL before applying"
        >
          <Eye className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
          Preview SQL
        </button>
        {safeMode && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-200"
            data-testid={`sql-data-migrate-safe-chip-${statementIndex}`}
            title="SQL Editor Safe mode is on — Apply will ask for confirmation"
          >
            <Shield className="w-3 h-3" strokeWidth={SQL_ICON_STROKE} />
            Safe mode
          </span>
        )}
        <button
          type="button"
          data-testid={`sql-data-migrate-apply-${statementIndex}`}
          disabled={
            applying ||
            restoring ||
            !canDml ||
            selected.uncappedCount === 0 ||
            migrateCount === 0 ||
            classification.duplicateKeys > 0 ||
            overCap
          }
          onClick={requestApply}
          className="ml-auto px-3 py-1 rounded-md bg-cyan-600/50 border border-cyan-400/50 text-sm font-bold text-cyan-100 hover:bg-cyan-500/60 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-cyan-500/20"
          title={
            selected.uncappedCount === 0
              ? 'Select Add, Edit, and/or Delete first'
              : migrateCount === 0
                ? 'Check rows in the Sync column'
                : overCap
                  ? `Over ${DATA_MIGRATE_ROW_CAP} ops — use Server Beam`
                  : safeMode
                    ? 'Safe mode is on — you will confirm before writes run'
                    : undefined
          }
        >
          {applying ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={SQL_ICON_STROKE} /> Migrating…
            </span>
          ) : overCap ? (
            `Over ${DATA_MIGRATE_ROW_CAP} — Server Beam`
          ) : selected.uncappedCount === 0 ? (
            'Select ops to migrate'
          ) : migrateCount === 0 ? (
            'Select Sync rows'
          ) : (
            `Apply · ${migrateCount}`
          )}
        </button>
      </div>

      {classification.unresolved > 0 && (
        <p
          className="text-[11px] font-semibold text-amber-400/90"
          data-testid={`sql-data-migrate-unresolved-${statementIndex}`}
        >
          {classification.unresolved} row{classification.unresolved === 1 ? ' is' : 's are'} on one
          side only, but the other side&apos;s result is cut off — they may just be further down, so
          they are not offered as Add or Delete. Raise Rows/page (or narrow the SELECT) to classify
          them. Edits are safe to apply: both copies are loaded.
        </p>
      )}

      {!editTarget.ok && (
        <p className="text-[11px] font-semibold text-amber-400/90">
          Migrate needs a single-table SELECT with schema loaded on the destination.
        </p>
      )}

      {failedSummary.length > 0 && (
        <div
          className="rounded border border-rose-500/30 bg-rose-950/30 px-2 py-1.5 text-[10px]"
          data-testid={`sql-data-migrate-failures-${statementIndex}`}
        >
          <div className="font-bold text-rose-300 mb-1">
            Failed records ({failedSummary.length})
          </div>
          <ul className="space-y-0.5 font-mono text-rose-200/90 max-h-24 overflow-auto">
            {failedSummary.map((r, i) => (
              <li key={`${r.op}-${r.key}-${i}`} title={r.error}>
                <span className="uppercase text-rose-400">{r.op}</span> {r.key}
                {r.error ? ` — ${r.error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {progress &&
        createPortal(
          <div
            className="fixed bottom-4 right-4 z-[360] w-[24rem] max-h-[50vh] overflow-auto rounded-lg border border-slate-700 bg-slate-950 shadow-xl"
            data-testid="sql-data-migrate-progress"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
              <span className="text-xs font-bold text-slate-200">Data migrate progress</span>
              {!applying && (
                <button data-testid="sql-data-migrate-progress-close"
                  type="button"
                  onClick={() => setProgress(null)}
                  className="text-slate-500 hover:text-slate-200"
                >
                  <X className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                </button>
              )}
            </div>
            <ul className="px-3 py-2 space-y-1 text-[10px] font-mono">
              {progress.map((p, i) => (
                <li key={`${p.op}-${p.keyLabel}-${i}`} className="flex items-start gap-2">
                  <span
                    className={
                      p.status === 'ok'
                        ? 'text-emerald-400'
                        : p.status === 'fail'
                          ? 'text-rose-400'
                          : p.status === 'skipped'
                            ? 'text-amber-400'
                            : p.status === 'running'
                              ? 'text-cyan-400'
                              : 'text-slate-500'
                    }
                  >
                    {p.status === 'running'
                      ? '…'
                      : p.status === 'ok'
                        ? '✓'
                        : p.status === 'fail'
                          ? '✗'
                          : p.status === 'skipped'
                            ? '–'
                            : '·'}
                  </span>
                  <span className="text-slate-400 uppercase w-12 shrink-0">{p.op}</span>
                  <span className="text-slate-300 min-w-0 break-all" title={p.error}>
                    {p.keyLabel}
                    {p.error ? (
                      <span className="block text-rose-400/90 font-sans normal-case">{p.error}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>,
          document.body
        )}

      {historyOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[370] flex items-center justify-center bg-black/50 p-4"
            data-testid="sql-data-migrate-history-modal"
            onClick={() => setHistoryOpen(false)}
          >
            <div
              className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-lg border border-slate-700 bg-slate-950 flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
                <span className="text-sm font-bold text-slate-100">Data migrate history</span>
                <button data-testid="sql-data-migrate-history-close" type="button" onClick={() => setHistoryOpen(false)} className="text-slate-500">
                  <X className="w-4 h-4" strokeWidth={SQL_ICON_STROKE} />
                </button>
              </div>
              <div className="flex min-h-0 flex-1">
                <ul className="w-48 shrink-0 border-r border-slate-800 overflow-y-auto text-[11px]">
                  {historyRuns.map((r) => (
                    <li key={r.id}>
                      <button data-testid={`sql-data-migrate-history-run-${r.id}`}
                        type="button"
                        className={`w-full text-left px-2 py-1.5 hover:bg-slate-900 ${
                          historyDetail?.id === r.id ? 'bg-slate-900 text-cyan-300' : 'text-slate-400'
                        }`}
                        onClick={() => void apiGetDataMigration(r.id).then(setHistoryDetail)}
                      >
                        <div className="font-semibold">{r.status}</div>
                        <div className="truncate">{r.tableName || r.targetHost || '—'}</div>
                        <div className="text-slate-600">{new Date(r.startedAt).toLocaleString()}</div>
                      </button>
                    </li>
                  ))}
                  {historyRuns.length === 0 && (
                    <li className="px-2 py-3 text-slate-600">No runs yet</li>
                  )}
                </ul>
                <div className="flex-1 overflow-auto p-3 text-[11px] text-slate-300 space-y-2">
                  {historyDetail ? (
                    <>
                      <div>
                        <span className="text-slate-500">Table</span> {historyDetail.tableName} ·{' '}
                        {historyDetail.rowCount} ops · keys [{historyDetail.keyColumns.join(', ')}]
                      </div>
                      <div>
                        <span className="text-slate-500">Snapshot (pre-apply Backup)</span>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-400">
                          {historyDetail.snapshotJson || '(none — Backup was off)'}
                        </pre>
                        {isUsableDataMigrateSnapshot(historyDetail.snapshotJson) &&
                          historyDetail.results.some((r) => r.status === 'SUCCESS') &&
                          historyDetail.status !== 'SUCCESS' && (
                            <button
                              type="button"
                              data-testid="sql-data-migrate-history-restore"
                              disabled={restoring || applying}
                              className="mt-2 inline-flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-950/40 px-2 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-900/50 disabled:opacity-40"
                              onClick={() => {
                                const connectionId =
                                  snapshotTargetConnectionId(historyDetail.snapshotJson!) ||
                                  // Legacy backups (pre-connectionId): only restore when the
                                  // current Destination still matches the recorded target.
                                  (historyDetail.targetHost &&
                                  destConn &&
                                  (destConn.host === historyDetail.targetHost ||
                                    dest.label === historyDetail.targetHost) &&
                                  (!historyDetail.database ||
                                    destConn.database === historyDetail.database)
                                    ? dest.connectionId
                                    : '');
                                if (!connectionId) {
                                  toast({
                                    tone: 'warning',
                                    title: 'Cannot restore',
                                    body: 'Select the original Destination credential for this backup before restoring.',
                                  });
                                  return;
                                }
                                setHistoryOpen(false);
                                void restoreFromBackup({
                                  runId: historyDetail.id,
                                  connectionId,
                                  snapshotJson: historyDetail.snapshotJson!,
                                  results: historyDetail.results,
                                  tableName: historyDetail.tableName || tableName,
                                  dialect: historyDetail.dialect || dest.dialect,
                                });
                              }}
                            >
                              <Undo2 className="w-3.5 h-3.5" strokeWidth={SQL_ICON_STROKE} />
                              Restore from this backup
                            </button>
                          )}
                        {historyDetail.snapshotJson &&
                          !isUsableDataMigrateSnapshot(historyDetail.snapshotJson) && (
                            <p className="mt-2 text-[11px] text-rose-300">
                              Snapshot is not valid JSON — Restore is unavailable (likely an
                              older truncated History entry).
                            </p>
                          )}
                      </div>
                      <div>
                        <span className="text-slate-500">Script</span>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-400">
                          {historyDetail.script || '(none)'}
                        </pre>
                      </div>
                      <div>
                        <span className="text-slate-500">Results</span>
                        <ul className="mt-1 space-y-0.5 font-mono text-[10px]">
                          {historyDetail.results.map((r, i) => (
                            <li key={i} className={r.status === 'SUCCESS' ? 'text-emerald-400' : 'text-rose-400'}>
                              {r.status} {r.op} {r.key}
                              {r.error ? ` — ${r.error}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </>
                  ) : (
                    <p className="text-slate-600">Select a run</p>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {previewOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[340] flex items-center justify-center bg-black/70 p-4"
            onClick={() => setPreviewOpen(false)}
          >
            <div
              className="flex max-h-[min(36rem,85vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              data-testid="sql-data-migrate-preview-modal"
            >
              <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                <h3 className="text-sm font-bold text-slate-100">Preview migrate SQL</h3>
                <button data-testid="sql-data-migrate-preview-close"
                  type="button"
                  onClick={() => setPreviewOpen(false)}
                  className="text-slate-500 hover:text-slate-200"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" strokeWidth={SQL_ICON_STROKE} />
                </button>
              </div>
              <pre className="flex-1 overflow-auto px-4 py-3 text-[11px] font-mono text-slate-300 whitespace-pre-wrap">
                {previewSql}
              </pre>
              <p className="border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
                Bound parameters are shown as placeholders in the plan text. Nothing runs until you
                click Apply.
              </p>
            </div>
          </div>,
          document.body
        )}

      {safeConfirmOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[350] flex items-center justify-center bg-black/70 p-4"
            onClick={() => setSafeConfirmOpen(false)}
          >
            <div
              className="w-full max-w-md rounded-xl border border-amber-500/40 bg-slate-900 p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              data-testid="sql-data-migrate-safe-confirm"
            >
              <h3 className="text-sm font-bold text-amber-100 mb-2 flex items-center gap-2">
                <Shield className="w-4 h-4" strokeWidth={SQL_ICON_STROKE} />
                Safe mode is on
              </h3>
              <p className="text-[12px] text-slate-400 mb-4">
                Applying will write {migrateCount} row operation
                {migrateCount === 1 ? '' : 's'} on{' '}
                <span className="font-mono text-slate-200">{dest.label}</span>. Confirm to continue.
              </p>
              <div className="flex justify-end gap-2">
                <button data-testid="sql-data-migrate-safe-cancel"
                  type="button"
                  className="px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
                  onClick={() => setSafeConfirmOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="sql-data-migrate-safe-confirm-apply"
                  className="px-3 py-1.5 text-xs font-bold rounded-md border border-cyan-400/50 bg-cyan-600/50 text-cyan-100"
                  onClick={() => {
                    setSafeConfirmOpen(false);
                    void apply();
                  }}
                >
                  Apply {migrateCount} ops
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

function canCompareReady(source: DataMigrateGrid, dest: DataMigrateGrid): boolean {
  return Boolean(source.columns.length && dest.columns.length);
}
