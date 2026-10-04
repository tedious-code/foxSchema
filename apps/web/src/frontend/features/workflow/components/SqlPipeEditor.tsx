/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL pipes' editor: pick one of your saved FoxSchema connections, browse
 * its tables, and write the query or statement with the dialect's highlighting.
 *
 * Picking a connection links it to workflows — FoxSchema records the grant and
 * the engine credential that points at it — so the pipe never holds a password.
 */
import Editor from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import { linkedConnectionId, type WorkflowConnectionSummary } from '@foxschema/workflow-contract';
import { useAuthStore } from '@/app/store/authStore';
import { monacoLanguage } from '@/monaco-setup';
import { loadSchema } from '@/shared/api/schemaApi';
import { FilterPicker, connectionPickerOption } from '@/shared/components/FilterPicker';
import { dialectLabel } from '@/shared/lib/dialectLabel';
import { quoteSqlIdentifier } from '@/shared/lib/sql-splitter';
import type { TableSchema } from '@/shared/lib/types';
import { workflowConnections } from '../api/workflowApi';
import { invalidateEngineQueries } from '../api/engineQueries';
import { JSON_EDITOR_OPTIONS, useJsonEditorTheme } from '../lib/jsonEditorOptions';
import { toast } from '../lib/notify';

export type SqlPipeType = 'source.db.sql' | 'sink.db.sql';

interface Props {
  type: SqlPipeType;
  config: Record<string, unknown>;
  credentialId: string;
  onConfigChange: (next: Record<string, unknown>) => void;
  onCredentialChange: (credentialId: string) => void;
}

/** A name part as the engine's qualified-name parser reads it: quoted only when it holds a dot. */
function namePart(part: string): string {
  return part.includes('.') ? `"${part.replace(/"/g, '""')}"` : part;
}

export function SqlPipeEditor({ type, config, credentialId, onConfigChange, onCredentialChange }: Props) {
  const canBrowse = useAuthStore((s) => s.can('schema.browse'));
  const theme = useJsonEditorTheme();
  const [connections, setConnections] = useState<WorkflowConnectionSummary[] | null>(null);
  const [linking, setLinking] = useState(false);
  // Tables are kept with the connection and schema they came from, so picking
  // another connection shows none rather than the previous one's.
  const [loaded, setLoaded] = useState<{ key: string; tables: TableSchema[] } | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);

  useEffect(() => {
    let cancelled = false;
    workflowConnections.list().then(
      (list) => {
        if (!cancelled) setConnections(list);
      },
      (error: Error) => {
        if (cancelled) return;
        setConnections([]);
        toast.error('Could not list saved connections', { description: error.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const connectionId = linkedConnectionId(credentialId);
  const connection = connections?.find((candidate) => candidate.id === connectionId);
  const schema = typeof config.schema === 'string' && config.schema ? config.schema : connection?.schema;
  const dialect = connection?.dialect ?? (typeof config.dialect === 'string' ? config.dialect : 'sql');
  const mode = type === 'source.db.sql' ? 'query' : config.mode === 'statement' ? 'statement' : 'insert';
  const sql = typeof config.sql === 'string' ? config.sql : '';
  const tablesKey = `${connectionId ?? ''}\0${schema ?? ''}`;
  const tables = loaded?.key === tablesKey ? loaded.tables : null;

  const link = async (id: string) => {
    if (!id) {
      onCredentialChange('');
      return;
    }
    setLinking(true);
    try {
      const { credentialId: linked } = await workflowConnections.grant(id);
      invalidateEngineQueries('credentials');
      setConnections(
        (current) => current?.map((candidate) => (candidate.id === id ? { ...candidate, granted: true } : candidate)) ?? null,
      );
      onCredentialChange(linked);
    } catch (error) {
      toast.error('Could not link the connection', { description: (error as Error).message });
    } finally {
      setLinking(false);
    }
  };

  const browse = async () => {
    if (!connectionId) return;
    setLoadingTables(true);
    try {
      const result = await loadSchema({ connectionId, ...(schema ? { schema } : {}) }, ['TABLE', 'VIEW']);
      setLoaded({ key: tablesKey, tables: result.tables });
    } catch (error) {
      toast.error('Could not load tables', { description: (error as Error).message });
    } finally {
      setLoadingTables(false);
    }
  };

  const pickTable = (table: TableSchema) => {
    const columns = table.columns.map((column) => column.name);
    if (type === 'sink.db.sql') {
      onConfigChange({
        ...config,
        mode: 'insert',
        table: [schema, table.name].filter(Boolean).map((part) => namePart(part!)).join('.'),
        columns,
      });
      return;
    }
    const quoted = (name: string) => quoteSqlIdentifier(name, dialect);
    const from = [schema, table.name].filter(Boolean).map((part) => quoted(part!)).join('.');
    const select = `SELECT ${columns.length ? columns.map(quoted).join(', ') : '*'}\nFROM ${from}`;
    onConfigChange({ ...config, sql: sql.trim() ? `${sql.trimEnd()}\n\n${select}` : select });
  };

  return (
    <div className="sql-pipe-editor">
      <label htmlFor="sql-pipe-connection">Database</label>
      <FilterPicker
        id="sql-pipe-connection"
        mode="single"
        testId="sql-pipe-connection"
        options={(connections ?? []).map((candidate) => ({
          ...connectionPickerOption(candidate),
          note: candidate.granted ? undefined : 'links it',
          testId: `sql-pipe-connection-option-${candidate.id}`,
        }))}
        selectedId={connectionId ?? null}
        onSelect={(id) => {
          if (id !== connectionId) void link(id);
        }}
        clearLabel={credentialId ? 'None' : undefined}
        disabled={linking || connections === null}
        placeholder="Filter by name, dialect, host…"
        summary={
          linking
            ? 'Linking…'
            : connections === null
              ? 'Loading saved connections…'
              : connection
                ? [connection.name, dialectLabel(connection.dialect), connection.database].filter(Boolean).join(' · ')
                : credentialId
                  ? `Engine credential: ${credentialId}`
                  : connections.length > 0
                    ? 'Choose a saved connection…'
                    : 'No saved connections'
        }
      />
      {connection && !connection.hasPassword && (
        <div className="field-error">
          This connection was saved without its password, so a run cannot sign in. Save the password with the
          connection in FoxSchema first.
        </div>
      )}
      <div className="hint">
        Linking lets workflows use the connection. FoxSchema keeps the password and hands it to the engine for
        each run.
      </div>

      {connectionId && canBrowse && (
        <>
          <button data-testid="workflow-sql-pipe-browse" type="button" className="linkish" disabled={loadingTables} onClick={() => void browse()}>
            {loadingTables ? 'Loading tables…' : tables ? 'Reload tables' : 'Browse tables'}
          </button>
          {tables && (
            <>
              <ul className="sql-pipe-tables" aria-label="Tables">
                {tables.length === 0 && <li className="hint">No tables in {schema ?? 'this schema'}.</li>}
                {tables.map((table) => (
                  <li key={`${table.objectType}:${table.name}`}>
                    <button data-testid={`workflow-sql-pipe-table-${table.objectType}-${table.name}`}
                      type="button"
                      className="linkish"
                      title={table.columns.map((column) => column.name).join(', ')}
                      onClick={() => pickTable(table)}
                    >
                      {table.name}
                    </button>
                    <span className="hint">
                      {' '}
                      {table.columns.length} columns{table.objectType === 'VIEW' ? ' · view' : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="hint">
                {type === 'sink.db.sql'
                  ? 'Pick the table to insert into; its columns become the column list.'
                  : 'Pick a table to add a SELECT of its columns.'}
              </div>
            </>
          )}
        </>
      )}

      {mode !== 'insert' && (
        <>
          <label>{mode === 'statement' ? 'Statement per record' : 'SQL'}</label>
          <div className="monaco-frame">
            <Editor
              height="180px"
              language={monacoLanguage(dialect)}
              theme={theme}
              value={sql}
              onChange={(value) => onConfigChange({ ...config, sql: value ?? '' })}
              options={{ ...JSON_EDITOR_OPTIONS, lineNumbers: 'on', wordWrap: 'on' }}
            />
          </div>
          <div className="hint">
            {mode === 'statement'
              ? '{{record.field}} binds a field of each record. '
              : 'A script runs statement by statement, and the last statement’s rows are emitted. '}
            {'{{vars.name}}'} and {'{{trigger.field}}'} are bound as parameters, never pasted into the SQL.
          </div>
        </>
      )}
    </div>
  );
}
