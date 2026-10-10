/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backup & Restore: the commands that back this connection up, and bring it
 * back.
 *
 * Fox Schema writes them and does not run them. The first thing on screen is
 * *where* they run, because that decides what the folder means: pg_dump writes
 * on the machine that runs it, SQL Server's BACKUP DATABASE on the database
 * server, Oracle into a DIRECTORY object. A folder typed on the wrong side of
 * that line is the most common way a backup "succeeds" into nowhere.
 *
 * Each engine's folder, format and scope can be saved as the user's default
 * for that engine; they live server-side, per user, and never hold a password.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Cloud, Copy, FileCode2, HardDrive, KeyRound, RotateCcw, Save, Server } from 'lucide-react';
import {
  backupFileName,
  backupSupport,
  buildBackupCommands,
  defaultBackupSettings,
  parseTableList,
  type BackupRunsOn,
  type BackupScope,
  type BackupSettings,
  type BackupHistoryEntry,
} from '@foxschema/ui-shared';
import { useSyncStore } from '@/features/compare';
import { useSqlEditorStore } from '@/features/sql-editor/state';
import { useUiStore } from '@/app/store/uiStore';
import { apiGetBackupSettings, apiSaveBackupSettings } from '@/shared/api/backupApi';
import { writeClipboard } from '@/shared/utils/clipboard';
import { dialectLabel } from '@/shared/lib/dialectLabel';
import { BackupServerActions } from './BackupServerActions';
import { EmptyState, Field, Segmented, inputCls } from '@/shared/components/controls';

const RUNS_ON: Record<BackupRunsOn, { label: string; body: string; Icon: React.ComponentType<{ className?: string }> }> = {
  client: {
    label: 'Runs on your machine',
    body: 'Run it anywhere the tool is installed and can reach the database. The file is written where you run it.',
    Icon: HardDrive,
  },
  server: {
    label: 'Runs on the database server',
    body: 'The database writes the backup itself, so the folder is on the database server, not on this computer.',
    Icon: Server,
  },
  cloud: {
    label: 'Kept by the cloud provider',
    body: 'A snapshot the provider stores for you. There is no file to place.',
    Icon: Cloud,
  },
};

/**
 * Scope in plain words first, with the database term after.
 *
 * "Schema only" means a namespace to half the engines Fox Schema supports and
 * "structure" to the other half; "DDL" means nothing to a reader who did not
 * come up through databases. Saying what is in the file answers all of them.
 */
const SCOPE_LABEL: Record<BackupScope, { label: string; title: string }> = {
  full: { label: 'Everything', title: 'Tables, views and routines, and their rows.' },
  schema: { label: 'Structure only (DDL)', title: 'The CREATE statements for tables, views and routines. No rows.' },
  data: { label: 'Rows only (data)', title: 'The rows, without the statements that create the tables.' },
};

const sameSettings = (a: BackupSettings, b: BackupSettings) =>
  a.folder === b.folder && a.format === b.format && a.scope === b.scope && a.compress === b.compress && a.limitToSchema === b.limitToSchema;

const CommandBlock: React.FC<{
  title: string;
  text: string;
  testId: string;
  canOpenInEditor: boolean;
  onOpen: () => void;
}> = ({ title, text, testId, canOpenInEditor, onOpen }) => {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/60" data-testid={testId}>
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-1.5">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{title}</h3>
        <div className="flex gap-1.5">
          <button
            type="button"
            data-testid={`${testId}-copy`}
            onClick={() => {
              void writeClipboard(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2 py-0.5 text-[11px] font-bold text-slate-200 hover:bg-slate-800"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {canOpenInEditor && (
            <button
              type="button"
              data-testid={`${testId}-open-sql`}
              onClick={onOpen}
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[11px] font-bold text-sky-100"
            >
              <FileCode2 className="w-3 h-3" /> Open in SQL Editor
            </button>
          )}
        </div>
      </div>
      <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11.5px] text-slate-200" data-testid={`${testId}-text`}>
        {text}
      </pre>
    </section>
  );
};

export const BackupRestorePanel: React.FC<{ lockedConnectionId?: string }> = ({ lockedConnectionId }) => {
  const connections = useSyncStore((s) => s.connections);
  const setSql = useSqlEditorStore((s) => s.setSql);
  const ensureConnectionSelected = useSqlEditorStore((s) => s.ensureConnectionSelected);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const conn = connections.find((c) => c.id === lockedConnectionId);
  const dialect = (conn?.dialect ?? '').toLowerCase();
  const support = useMemo(() => (dialect ? backupSupport(dialect) : undefined), [dialect]);

  const [saved, setSaved] = useState<Record<string, BackupSettings> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [settings, setSettings] = useState<BackupSettings>(() => defaultBackupSettings(dialect));
  const [fileName, setFileName] = useState('');
  const [tablesText, setTablesText] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | { error: string }>('idle');
  /** A backup picked from the server's history, for the restore to read. */
  const [picked, setPicked] = useState<BackupHistoryEntry | null>(null);

  useEffect(() => {
    let live = true;
    apiGetBackupSettings()
      .then((s) => live && setSaved(s))
      .catch(() => live && (setSaved({}), setLoadFailed(true)));
    return () => {
      live = false;
    };
  }, []);

  // A connection change starts from that engine's saved default, a fresh
  // file name, and no table filter carried over from another database.
  const savedForDialect = saved?.[dialect];
  const savedLoaded = saved !== null;
  const edited = useRef(false);
  useEffect(() => {
    edited.current = false;
    setSettings(saved?.[dialect] ?? defaultBackupSettings(dialect));
    setFileName(conn?.database ? backupFileName(conn.database, new Date()) : '');
    setTablesText('');
    setSaveState('idle');
    setPicked(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `saved` arrives on its own below
  }, [lockedConnectionId, dialect, conn?.database]);
  // Saved defaults arrive after the first paint. They apply only if the reader
  // has not started editing — and only on that first arrival: saving replaces
  // them, and re-applying then would undo nothing but still look like a reset.
  useEffect(() => {
    if (savedLoaded && !edited.current) setSettings(saved?.[dialect] ?? defaultBackupSettings(dialect));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first arrival only, see above
  }, [savedLoaded]);

  const commands = useMemo(() => {
    if (!conn || !support) return null;
    return buildBackupCommands(
      {
        dialect,
        host: conn.host,
        port: conn.port,
        database: conn.database ?? '',
        schema: conn.schema,
        username: conn.username,
      },
      { ...settings, fileName, tables: parseTableList(tablesText), restoreFrom: picked?.restoreKey }
    );
  }, [conn, support, dialect, settings, fileName, tablesText, picked]);

  const baseline = savedForDialect ?? defaultBackupSettings(dialect);
  const changed = !sameSettings(settings, baseline);
  const patch = (p: Partial<BackupSettings>) => {
    edited.current = true;
    setSettings((s) => ({ ...s, ...p }));
    setSaveState('idle');
  };

  const openInEditor = (sql: string) => {
    if (!lockedConnectionId) return;
    setSql?.(sql);
    ensureConnectionSelected?.(lockedConnectionId);
    setActiveView('sqlEditor');
  };

  const save = async () => {
    setSaveState('saving');
    try {
      const stored = await apiSaveBackupSettings(dialect, settings);
      setSaved((s) => ({ ...(s ?? {}), [dialect]: stored }));
      setSaveState('saved');
    } catch (err) {
      setSaveState({ error: err instanceof Error ? err.message : 'Could not save.' });
    }
  };

  if (!conn) {
    return (
      <div className="p-4" data-testid="backup-panel">
        <EmptyState title="Choose a connection" body="Pick a saved database above to write its backup and restore commands." testId="backup-no-connection" />
      </div>
    );
  }
  if (!support) {
    return (
      <div className="p-4" data-testid="backup-panel">
        <EmptyState title="No backup commands" body={`Fox Schema has no backup commands for ${dialectLabel(conn.dialect)}.`} testId="backup-unsupported" />
      </div>
    );
  }

  const runsOn = RUNS_ON[support.runsOn];
  const format = support.formats.find((f) => f.id === settings.format) ?? support.formats[0]!;
  const language = commands && !('error' in commands) ? commands.language : 'shell';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="backup-panel">
      <header className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-[12px] text-slate-300">
          <span className="font-semibold text-slate-100">{support.tool}</span>
          <span className="text-slate-400">
            {support.runsOn === 'server' && language === 'sql'
              ? ' · Fox Schema writes these commands, and runs the backup only when you ask it to.'
              : ' · Fox Schema writes these commands; it does not run them.'}
          </span>
        </p>
        <div
          className="flex max-w-md items-start gap-2 rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-100"
          data-testid="backup-runs-on"
        >
          <runsOn.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-bold">{runsOn.label}.</span> {runsOn.body}
          </span>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        {support.folder && (
          <Field label={support.folder.label} hint={support.folder.hint}>
            <input
              data-testid="backup-folder"
              value={settings.folder}
              onChange={(e) => patch({ folder: e.target.value })}
              placeholder={support.folder.defaultValue}
              className={inputCls}
            />
          </Field>
        )}
        <Field label="File name" hint="Without an extension; the format adds its own.">
          <input
            data-testid="backup-file-name"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            className={inputCls}
          />
        </Field>
        {support.formats.length > 1 && (
          <Field label="Format" hint={format.hint}>
            <Segmented
              testId="backup-format"
              value={format.id}
              onChange={(v) => patch({ format: v })}
              options={support.formats.map((f) => ({ value: f.id, label: f.label, title: f.hint }))}
            />
          </Field>
        )}
        {support.scopes.length > 1 && (
          <Field label="What to back up" hint={SCOPE_LABEL[settings.scope].title}>
            <Segmented
              testId="backup-scope"
              value={settings.scope}
              onChange={(v) => patch({ scope: v as BackupScope })}
              options={support.scopes.map((s) => ({ value: s, label: SCOPE_LABEL[s].label, title: SCOPE_LABEL[s].title }))}
            />
          </Field>
        )}
        {support.tables && (
          <Field label="Only these tables" hint="Optional. Comma- or line-separated; empty backs up everything.">
            <textarea
              data-testid="backup-tables"
              rows={2}
              value={tablesText}
              onChange={(e) => setTablesText(e.target.value)}
              placeholder="orders, customers"
              className={inputCls}
            />
          </Field>
        )}
        <div className="flex flex-col justify-end gap-1.5">
          {support.compression && (
            <label className="flex items-center gap-2 text-[12px] text-slate-300">
              <input
                type="checkbox"
                data-testid="backup-compress"
                checked={settings.compress}
                onChange={(e) => patch({ compress: e.target.checked })}
                className="accent-amber-500"
              />
              Compress the backup
            </label>
          )}
          {support.schemaLimit && conn.schema && (
            <label className="flex items-center gap-2 text-[12px] text-slate-300">
              <input
                type="checkbox"
                data-testid="backup-limit-schema"
                checked={settings.limitToSchema}
                onChange={(e) => patch({ limitToSchema: e.target.checked })}
                className="accent-amber-500"
              />
              Only the <span className="font-mono">{conn.schema}</span> schema
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="backup-save-default"
          disabled={!changed || saveState === 'saving'}
          onClick={() => void save()}
          className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-bold text-amber-100 disabled:opacity-40"
        >
          <Save className="h-3 w-3" /> Save as my default for {dialectLabel(conn.dialect)}
        </button>
        <button
          type="button"
          data-testid="backup-reset"
          disabled={!changed}
          onClick={() => setSettings(baseline)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:text-slate-200 disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" /> {savedForDialect ? 'Back to my default' : 'Back to the engine’s default'}
        </button>
        <span className="text-[11px] text-slate-500" data-testid="backup-save-status">
          {saveState === 'saved'
            ? 'Saved. New backups of this engine start from these settings.'
            : saveState === 'saving'
              ? 'Saving…'
              : typeof saveState === 'object'
                ? saveState.error
                : loadFailed
                  ? 'Your saved defaults could not be loaded; showing the engine’s.'
                  : savedForDialect
                    ? 'Using your saved default for this engine.'
                    : ''}
        </span>
      </div>

      {commands && 'error' in commands ? (
        <p className="text-[11px] text-rose-300" data-testid="backup-error">
          {commands.error}
        </p>
      ) : commands ? (
        <>
          <CommandBlock
            title="Backup"
            text={commands.backup}
            testId="backup-command"
            canOpenInEditor={language === 'sql'}
            onOpen={() => openInEditor(commands.backup)}
          />
          <BackupServerActions
            connection={conn}
            runnable={support.runsOn === 'server' && language === 'sql'}
            commands={commands}
            picked={picked}
            onPick={setPicked}
          />
          <CommandBlock
            title={picked ? `Restore · the backup from ${picked.finishedAt}` : 'Restore'}
            text={commands.restore}
            testId="restore-command"
            canOpenInEditor={language === 'sql'}
            onOpen={() => openInEditor(commands.restore)}
          />
          <ul className="flex flex-col gap-1 text-[11px] text-slate-400" data-testid="backup-notes">
            <li className="flex items-start gap-2">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span>{support.passwordNote}</span>
            </li>
            {commands.notes.map((note) => (
              <li key={note} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/80" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
};
