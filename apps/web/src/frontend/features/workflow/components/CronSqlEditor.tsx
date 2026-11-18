/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Schedule trigger's "SQL execute" settings: which saved connection the
 * script runs against, the script itself, and whether an empty result still
 * starts a run.
 *
 * The connection is picked the way the SQL pipes pick one — linking a saved
 * FoxSchema connection to workflows, which hands back an engine credential
 * that points at it. The trigger stores that credential id, never a password.
 */
import Editor from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import { linkedConnectionId, type WorkflowConnectionSummary } from '@foxschema/workflow-contract';
import { monacoLanguage } from '@/features/sql-editor/monaco';
import { FilterPicker, connectionPickerOption } from '@/shared/components/FilterPicker';
import { dialectLabel } from '@/shared/lib/dialectLabel';
import { connectionNeedsSecret } from '@/shared/lib/provider-settings';
import { workflowConnections } from '../api/workflowApi';
import { invalidateEngineQueries } from '../api/engineQueries';
import { JSON_EDITOR_OPTIONS, useJsonEditorTheme } from '../lib/jsonEditorOptions';
import { toast } from '../lib/notify';
import type { CronSqlValue } from '../lib/triggers';

interface Props {
  value: CronSqlValue;
  onChange: (next: CronSqlValue) => void;
  /** Taller editor in the Triggers dialog, shorter in the inspector. */
  editorHeight?: string;
}

const MAX_ROWS_LIMIT = 10_000;

export function CronSqlEditor({ value, onChange, editorHeight = '180px' }: Props): React.JSX.Element {
  const theme = useJsonEditorTheme();
  const [connections, setConnections] = useState<WorkflowConnectionSummary[] | null>(null);
  const [linking, setLinking] = useState(false);

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

  const connectionId = linkedConnectionId(value.credentialId);
  const connection = connections?.find((candidate) => candidate.id === connectionId);
  const dialect = connection?.dialect ?? value.dialect ?? 'sql';

  const link = async (id: string) => {
    if (!id) {
      onChange({ ...value, credentialId: '' });
      return;
    }
    setLinking(true);
    try {
      const { credentialId } = await workflowConnections.grant(id);
      invalidateEngineQueries('credentials');
      setConnections(
        (current) => current?.map((candidate) => (candidate.id === id ? { ...candidate, granted: true } : candidate)) ?? null,
      );
      onChange({ ...value, credentialId });
    } catch (error) {
      toast.error('Could not link the connection', { description: (error as Error).message });
    } finally {
      setLinking(false);
    }
  };

  return (
    <div className="sql-pipe-editor cron-sql-editor" data-testid="workflow-cron-sql">
      <label htmlFor="workflow-cron-sql-connection">Database</label>
      <FilterPicker
        id="workflow-cron-sql-connection"
        mode="single"
        testId="workflow-cron-sql-connection"
        options={(connections ?? []).map((candidate) => ({
          ...connectionPickerOption(candidate),
          note: candidate.granted ? undefined : 'links it',
          testId: `workflow-cron-sql-connection-option-${candidate.id}`,
        }))}
        selectedId={connectionId ?? null}
        onSelect={(id) => {
          if (id !== connectionId) void link(id);
        }}
        clearLabel={value.credentialId ? 'None' : undefined}
        disabled={linking || connections === null}
        placeholder="Filter by name, dialect, host…"
        summary={
          linking
            ? 'Linking…'
            : connections === null
              ? 'Loading saved connections…'
              : connection
                ? [connection.name, dialectLabel(connection.dialect), connection.database].filter(Boolean).join(' · ')
                : value.credentialId
                  ? `Engine credential: ${value.credentialId}`
                  : connections.length > 0
                    ? 'Choose a saved connection…'
                    : 'No saved connections'
        }
      />
      {!value.credentialId && (
        <div className="field-error">Choose the connection the script runs against.</div>
      )}
      {connection &&
        !connection.hasPassword &&
        connectionNeedsSecret(connection.dialect, connection.authMethod, connection.username) && (
          <div className="field-error">
            This connection was saved without its password, so the schedule cannot sign in. Save the password
            with the connection in FoxSchema first.
          </div>
        )}

      <label>SQL script</label>
      <div className="monaco-frame" data-testid="workflow-cron-sql-script">
        <Editor
          height={editorHeight}
          language={monacoLanguage(dialect)}
          theme={theme}
          value={value.script}
          onChange={(script) => onChange({ ...value, script: script ?? '' })}
          options={{ ...JSON_EDITOR_OPTIONS, lineNumbers: 'on', wordWrap: 'on' }}
        />
      </div>
      <div className="hint">
        Runs on every fire, statement by statement. The last statement’s rows start the workflow, one record per
        row, and flow into the pipes after this trigger. The script may change data, so point it at a connection
        whose account can do only what you intend.
      </div>

      <label className="checkbox-row">
        <input
          data-testid="workflow-cron-sql-only-when-rows"
          type="checkbox"
          checked={value.onlyWhenRows}
          onChange={(event) => onChange({ ...value, onlyWhenRows: event.target.checked })}
        />
        Start only when rows are returned
      </label>
      <div className="hint">
        {value.onlyWhenRows
          ? 'A fire whose script returns nothing creates no run.'
          : 'Every fire starts a run; with no rows the pipes get one record with the schedule time and rowCount 0.'}
      </div>

      <label className="checkbox-row">
        <input
          data-testid="workflow-cron-sql-transaction"
          type="checkbox"
          checked={value.transaction}
          onChange={(event) => onChange({ ...value, transaction: event.target.checked })}
        />
        Run the script in a transaction
      </label>

      <label htmlFor="workflow-cron-sql-max-rows">Max rows per run</label>
      <input
        id="workflow-cron-sql-max-rows"
        data-testid="workflow-cron-sql-max-rows"
        type="number"
        min={1}
        max={MAX_ROWS_LIMIT}
        value={value.maxRows}
        onChange={(event) =>
          onChange({
            ...value,
            maxRows: Math.min(MAX_ROWS_LIMIT, Math.max(1, Math.trunc(Number(event.target.value)) || 1)),
          })
        }
      />
    </div>
  );
}
