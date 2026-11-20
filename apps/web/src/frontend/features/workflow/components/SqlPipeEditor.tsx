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
import { Key, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  linkedConnectionId,
  type ColumnMappingItem,
  type WorkflowConnectionSummary,
} from '@foxschema/workflow-contract';
import { useAuthStore } from '@/platform/authStore';
import { monacoLanguage } from '@/features/sql-editor/monaco';
import { loadSchema } from '@/shared/api/schemaApi';
import { FilterPicker, connectionPickerOption } from '@/shared/components/FilterPicker';
import { dialectLabel } from '@/shared/lib/dialectLabel';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { quoteSqlIdentifier } from '@/shared/lib/sql-splitter';
import type { TableSchema } from '@/shared/lib/types';
import { workflowConnections } from '../api/workflowApi';
import { invalidateEngineQueries } from '../api/engineQueries';
import { JSON_EDITOR_OPTIONS, useJsonEditorTheme } from '../lib/jsonEditorOptions';
import { toast } from '../lib/notify';
import { Button, Input, Select } from './controls';

export type SqlPipeType = 'source.db.sql' | 'sink.db.sql' | 'sink.db.mapped-insert';

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
  const isMappedPipe = type === 'sink.db.mapped-insert';
  const isSink = type === 'sink.db.sql' || isMappedPipe;
  const mode = type === 'source.db.sql'
    ? 'query'
    : isMappedPipe
      ? 'mapped'
      : config.mode === 'statement'
        ? 'statement'
        : config.mode === 'mapped'
          ? 'mapped'
          : 'insert';
  const sql = typeof config.sql === 'string' ? config.sql : '';
  const tablesKey = `${connectionId ?? ''}\0${schema ?? ''}`;
  const tables = loaded?.key === tablesKey ? loaded.tables : null;

  const rawMapping = Array.isArray(config.columnMapping) ? (config.columnMapping as ColumnMappingItem[]) : [];
  const currentKeys: string[] = Array.isArray(config.upsertKeys)
    ? (config.upsertKeys as string[])
    : typeof config.upsertKey === 'string' && config.upsertKey.trim()
      ? config.upsertKey.split(',').map((k) => k.trim()).filter(Boolean)
      : Array.isArray(config.upsertKey)
        ? (config.upsertKey as string[])
        : rawMapping.filter((m) => m.isKey).map((m) => m.targetColumn).filter(Boolean);

  const columnMapping: ColumnMappingItem[] = rawMapping.map((item) => ({
    ...item,
    isKey: item.isKey ?? (item.targetColumn ? currentKeys.includes(item.targetColumn) : false),
  }));

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
    const tableName = [schema, table.name].filter(Boolean).map((part) => namePart(part!)).join('.');
    const pkCols = table.primaryKey?.columns ?? [];

    if (mode === 'mapped') {
      const mappings: ColumnMappingItem[] = table.columns.map((column) => ({
        targetColumn: column.name,
        sourceProperty: column.name,
        isKey: pkCols.includes(column.name),
      }));
      onConfigChange({
        ...config,
        mode: 'mapped',
        table: tableName,
        columnMapping: mappings,
        ...(pkCols.length > 0 ? { upsertKeys: pkCols } : {}),
      });
      return;
    }

    if (type === 'sink.db.sql' && mode === 'insert') {
      onConfigChange({
        ...config,
        mode: 'insert',
        table: tableName,
        columns,
      });
      return;
    }

    const quoted = (name: string) => quoteSqlIdentifier(name, dialect);
    const from = [schema, table.name].filter(Boolean).map((part) => quoted(part!)).join('.');
    const select = `SELECT ${columns.length ? columns.map(quoted).join(', ') : '*'}\nFROM ${from}`;
    onConfigChange({ ...config, sql: sql.trim() ? `${sql.trimEnd()}\n\n${select}` : select });
  };

  const toggleKey = (index: number) => {
    const item = columnMapping[index];
    if (!item || !item.targetColumn) return;
    const willBeKey = !item.isKey;
    const updatedMappings = columnMapping.map((col, i) =>
      i === index ? { ...col, isKey: willBeKey } : col,
    );
    const nextKeys = willBeKey
      ? Array.from(new Set([...currentKeys, item.targetColumn]))
      : currentKeys.filter((k) => k !== item.targetColumn);
    onConfigChange({
      ...config,
      upsertKeys: nextKeys,
      columnMapping: updatedMappings,
    });
  };

  const addMappingItem = () => {
    const next = [...columnMapping, { targetColumn: '', sourceProperty: '' }];
    onConfigChange({ ...config, columnMapping: next });
  };

  const updateMappingItem = (index: number, patch: Partial<ColumnMappingItem>) => {
    const next = columnMapping.map((item, i) => {
      if (i !== index) return item;
      const merged = { ...item, ...patch };
      if (!merged.defaultValue) delete merged.defaultValue;
      if (!merged.transform) delete merged.transform;
      return merged;
    });
    onConfigChange({ ...config, columnMapping: next });
  };

  const removeMappingItem = (index: number) => {
    const removed = columnMapping[index];
    const next = columnMapping.filter((_, i) => i !== index);
    const nextKeys = removed?.targetColumn
      ? currentKeys.filter((k) => k !== removed.targetColumn)
      : currentKeys;
    onConfigChange({
      ...config,
      upsertKeys: nextKeys,
      columnMapping: next,
    });
  };

  const autoMapFromLoadedTable = () => {
    if (!tables || tables.length === 0) return;
    const rawTable = typeof config.table === 'string' ? config.table : '';
    const cleanTable = rawTable.includes('.') ? rawTable.split('.').pop() : rawTable;
    const match = tables.find((t) => t.name === cleanTable || t.name === rawTable) ?? tables[0];
    if (!match) return;
    pickTable(match);
  };

  // Live SQL preview for mapped mode
  const previewColumns = columnMapping.map((m) => m.targetColumn).filter(Boolean);
  const previewTable = typeof config.table === 'string' && config.table ? config.table : 'target_table';
  const previewCondition = typeof config.upsertCondition === 'string' ? config.upsertCondition.trim() : '';
  let previewSql = '';
  if (previewColumns.length > 0) {
    previewSql = `INSERT INTO ${previewTable} (${previewColumns.join(', ')})\nVALUES (${previewColumns.map(() => '?').join(', ')})`;
    if (currentKeys.length > 0) {
      const updateCols = previewColumns.filter((c) => !currentKeys.includes(c));
      if (updateCols.length > 0) {
        previewSql += `\nON CONFLICT (${currentKeys.join(', ')}) DO UPDATE SET\n  ${updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(',\n  ')}`;
        if (previewCondition) {
          previewSql += `\nWHERE ${previewCondition}`;
        }
      } else {
        previewSql += `\nON CONFLICT (${currentKeys.join(', ')}) DO NOTHING`;
      }
    }
  }

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
                  : config.dialect === 'sqlite'
                    ? 'Built-in SQLite (in-memory) · or choose a saved connection…'
                    : config.dialect === 'postgres'
                      ? 'PostgreSQL (localhost:5432/foxdb) · or choose a saved connection…'
                      : connections.length > 0
                      ? 'Choose a saved connection…'
                      : 'No saved connections'
        }
      />
      {connection &&
        !connection.hasPassword &&
        connectionNeedsSecret(connection.dialect, connection.authMethod, connection.username) && (
          <div className="field-error">
            This connection was saved without its password, so a run cannot sign in. Save the password with the
            connection in FoxSchema first.
          </div>
        )}
      <div className="hint">
        Linking lets workflows use the connection. Only members of its workspace can save, run or inspect a
        workflow that uses it. FoxSchema keeps the password and hands it to the engine for each run.
      </div>
      {!credentialId && (
        <>
          <label>Built-in database dialect</label>
          <Select
            aria-label="Fallback dialect"
            value={config.dialect === 'postgres' ? 'postgres' : 'sqlite'}
            onChange={(event) =>
              onConfigChange({
                ...config,
                dialect: event.target.value,
              })
            }
          >
            <option value="sqlite">Built-in SQLite (in-memory)</option>
            <option value="postgres">Local PostgreSQL (localhost:5432/foxdb)</option>
          </Select>
        </>
      )}

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
                {isSink
                  ? 'Pick the table to write into; its columns populate target fields.'
                  : 'Pick a table to add a SELECT of its columns.'}
              </div>
            </>
          )}
        </>
      )}

      {isSink && !isMappedPipe && (
        <>
          <label>Write mode</label>
          <Select
            aria-label="Write mode"
            value={mode ?? 'insert'}
            onChange={(event) => {
              const nextMode = event.target.value as 'insert' | 'statement' | 'mapped';
              onConfigChange({ ...config, mode: nextMode });
            }}
          >
            <option value="insert">Insert rows into table</option>
            <option value="mapped">Mapped column insert / upsert (ETL)</option>
            <option value="statement">Run SQL statement per record</option>
          </Select>
        </>
      )}

      {mode === 'insert' && (
        <>
          <label>Target table</label>
          <Input
            aria-label="Target table"
            placeholder={schema ? `${schema}.orders` : 'orders'}
            value={typeof config.table === 'string' ? config.table : ''}
            onChange={(event) =>
              onConfigChange({
                ...config,
                mode: 'insert',
                table: event.target.value,
              })
            }
          />
          <label>Columns (comma-separated, optional)</label>
          <Input
            aria-label="Columns"
            placeholder="Leave blank to insert all record fields"
            value={
              Array.isArray(config.columns)
                ? config.columns.map(String).join(', ')
                : ''
            }
            onChange={(event) => {
              const cols = event.target.value
                .split(',')
                .map((col) => col.trim())
                .filter(Boolean);
              onConfigChange({
                ...config,
                mode: 'insert',
                columns: cols,
              });
            }}
          />
        </>
      )}

      {mode === 'mapped' && (
        <div className="mapped-columns-container">
          <label>Target table</label>
          <Input
            aria-label="Target table"
            data-testid="workflow-sql-table"
            placeholder={schema ? `${schema}.users` : 'users'}
            value={typeof config.table === 'string' ? config.table : ''}
            onChange={(event) =>
              onConfigChange({
                ...config,
                mode: 'mapped',
                table: event.target.value,
              })
            }
          />

          <label>Combination keys (composite upsert, comma-separated)</label>
          <Input
            aria-label="Combination keys"
            data-testid="workflow-sql-upsert-keys"
            placeholder="e.g. tenant_id, user_id"
            value={currentKeys.join(', ')}
            onChange={(event) => {
              const keys = event.target.value
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean);
              const updatedMappings = columnMapping.map((col) => ({
                ...col,
                isKey: keys.includes(col.targetColumn),
              }));
              onConfigChange({
                ...config,
                upsertKeys: keys,
                ...(columnMapping.length > 0 ? { columnMapping: updatedMappings } : {}),
              });
            }}
          />
          <div className="hint">
            Combination keys identify existing records. Matching keys update rows; non-matching keys insert new rows. Key columns are omitted from UPDATE SET.
          </div>

          <label>Update condition (optional)</label>
          <Input
            aria-label="Update condition"
            data-testid="workflow-sql-upsert-condition"
            placeholder="e.g. EXCLUDED.updated_at >= target.updated_at"
            value={typeof config.upsertCondition === 'string' ? config.upsertCondition : ''}
            onChange={(event) =>
              onConfigChange({
                ...config,
                upsertCondition: event.target.value || undefined,
              })
            }
          />
          <div className="hint">
            Appended as a WHERE clause to DO UPDATE SET (e.g. to ignore outdated record streams).
          </div>

          <div className="flex items-center justify-between mt-2 mb-1">
            <label className="m-0 font-medium text-slate-200">Side-by-side Column Mapping</label>
            {tables && tables.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="workflow-sql-automap"
                onClick={autoMapFromLoadedTable}
                title="Populate columns from selected table"
              >
                <Sparkles size={12} className="mr-1 text-amber-400" /> Auto-map
              </Button>
            )}
          </div>

          <div className="overflow-x-auto rounded border border-slate-700 bg-slate-900/60 p-1">
            <table className="mapped-columns-table">
              <thead>
                <tr>
                  <th style={{ width: '28%' }}>Target DB Column</th>
                  <th style={{ width: '38px', textAlign: 'center' }} title="Mark as combination key">Key</th>
                  <th style={{ width: '30%' }}>Source Object Path</th>
                  <th style={{ width: '22%' }}>Transform (JS)</th>
                  <th style={{ width: '15%' }}>Default</th>
                  <th style={{ width: '28px' }}></th>
                </tr>
              </thead>
              <tbody>
                {columnMapping.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-3 text-slate-400 text-xs">
                      No column mappings yet. Click &quot;Add column mapping&quot; or pick a table above.
                    </td>
                  </tr>
                )}
                {columnMapping.map((item, index) => (
                  <tr key={index} data-testid={`workflow-sql-mapping-row-${index}`}>
                    <td>
                      <Input
                        aria-label={`Target column ${index + 1}`}
                        data-testid={`workflow-sql-target-col-${index}`}
                        placeholder="e.g. user_id"
                        value={item.targetColumn}
                        onChange={(e) => updateMappingItem(index, { targetColumn: e.target.value })}
                        className="text-xs py-1"
                      />
                    </td>
                    <td className="text-center">
                      <button
                        type="button"
                        aria-label={`Toggle combination key for ${item.targetColumn || `column ${index + 1}`}`}
                        data-testid={`workflow-sql-key-col-${index}`}
                        className={`mapped-key-btn ${item.isKey ? 'active' : ''}`}
                        title={item.isKey ? 'Part of combination key' : 'Click to make part of combination key'}
                        onClick={() => toggleKey(index)}
                      >
                        <Key size={12} />
                      </button>
                    </td>
                    <td>
                      <Input
                        aria-label={`Source property path ${index + 1}`}
                        data-testid={`workflow-sql-source-prop-${index}`}
                        placeholder="e.g. user.id"
                        value={item.sourceProperty ?? item.sourcePath ?? ''}
                        onChange={(e) => updateMappingItem(index, { sourceProperty: e.target.value })}
                        className="text-xs py-1 font-mono"
                      />
                    </td>
                    <td>
                      <Input
                        aria-label={`Transform expression ${index + 1}`}
                        data-testid={`workflow-sql-transform-${index}`}
                        placeholder="value.trim()"
                        value={item.transform ?? item.expression ?? ''}
                        onChange={(e) => updateMappingItem(index, { transform: e.target.value })}
                        className="text-xs py-1 font-mono"
                      />
                    </td>
                    <td>
                      <Input
                        aria-label={`Default value ${index + 1}`}
                        data-testid={`workflow-sql-default-${index}`}
                        placeholder="null"
                        value={item.defaultValue !== undefined ? String(item.defaultValue) : ''}
                        onChange={(e) => updateMappingItem(index, { defaultValue: e.target.value })}
                        className="text-xs py-1"
                      />
                    </td>
                    <td className="text-center">
                      <button
                        type="button"
                        aria-label={`Remove mapping ${index + 1}`}
                        data-testid={`workflow-sql-remove-col-${index}`}
                        className="text-slate-400 hover:text-rose-400 p-1"
                        onClick={() => removeMappingItem(index)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2 mt-1">
            <Button
              variant="ghost"
              size="sm"
              data-testid="workflow-sql-add-column-mapping"
              onClick={addMappingItem}
            >
              <Plus size={13} className="mr-1" /> Add column mapping
            </Button>
          </div>

          <div className="hint">
            Source paths support dot notation (e.g. <code>profile.billing.cents</code>). Transform expressions receive <code>value</code> and <code>record</code> (e.g. <code>value / 100</code>).
          </div>

          {previewSql && (
            <>
              <label className="text-xs text-slate-400 mt-2">Generated SQL Preview</label>
              <pre className="mapped-sql-preview">{previewSql}</pre>
            </>
          )}
        </div>
      )}

      {mode === 'statement' || mode === 'query' ? (
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
      ) : null}
    </div>
  );
}
