/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/Inspector.tsx).
 */
import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  ArrowDownToLine,
  Braces,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { FilterPicker } from '@/shared/components/FilterPicker';
import type { CredentialMeta, WorkflowSummary } from '../api/engineClient';
import type { CatalogCategory, CatalogEntry } from '../lib/catalog';
import {
  samplesForPipe,
  type DebugSample,
} from '../hooks/useDebugSamples';
import { DelimitedSourceEditor } from './DelimitedSourceEditor';
import {
  EMPTY_HTTP_REQUEST,
  HttpRequestEditor,
  toHttpRequestValue,
  type HttpRequestValue,
} from './HttpRequestEditor';
import { MultiHttpEditor } from './MultiHttpEditor';
import { SqlPipeEditor, type SqlPipeType } from './SqlPipeEditor';
import type { PipeData } from './PipeNode';
import { TriggerInlineSettings } from './TriggerInlineSettings';
import { JSON_EDITOR_OPTIONS, useJsonEditorTheme } from '../lib/jsonEditorOptions';
import { portLabel } from '../lib/ports';
import type { WorkflowTrigger } from '../lib/triggers';

/**
 * Config keys the HTTP request editor owns for `source.api.http`, kept out of
 * the generic fields so each key has exactly one editor.
 *
 * Derived from the editor's own value rather than listed by hand. The hand list
 * had missed `variables`, `session` and `tokenRefresh`, which then rendered
 * twice — in the editor's tabs and again as generic JSON fields.
 */
const HTTP_REQUEST_KEYS = new Set<string>([
  ...Object.keys(EMPTY_HTTP_REQUEST),
  // Optional on HttpRequestValue, so absent from the empty value.
  'tokenRefresh',
  // Legacy wrapper that toHttpRequestValue still unwraps.
  'request',
]);

/** The closed credential picker's text; an id the list no longer has still shows. */
function credentialSummary(credentials: readonly CredentialMeta[], credentialId: string): string {
  const credential = credentials.find((candidate) => candidate.id === credentialId);
  if (credential) return `${credential.name} (${credential.kind})`;
  return credentialId || 'none';
}

interface Props {
  pipeId: string | null;
  data: PipeData | null;
  credentials: CredentialMeta[];
  categories: CatalogCategory[];
  catalog: CatalogEntry[];
  /** Workflow-level triggers a trigger node can bind to. */
  triggers: WorkflowTrigger[];
  /** Id of the workflow being edited — excluded from the sub-workflow picker. */
  workflowId: string;
  /** Saved workflows a `workflow.sub` pipe can call. */
  workflows: WorkflowSummary[];
  /** Latest debug run id (Test run) — powers Input/Output sample tabs. */
  debugRunId?: string | null;
  debugSamples?: DebugSample[];
  debugRunStatus?: string | null;
  debugRunError?: string | null;
  onRename: (oldId: string, newId: string) => string | null;
  onChange: (pipeId: string, patch: Partial<PipeData>) => void;
  /** Replaces the workflow trigger list (inline trigger editing). */
  onTriggersChange: (triggers: WorkflowTrigger[]) => void;
  /** Opens the trigger dialog focused on `triggerId`. */
  onEditTrigger: (triggerId: string) => void;
}

type SchemaProperty = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  additionalProperties?: unknown;
};

type InspectorTab = 'settings' | 'input' | 'output' | 'error';

const INSPECTOR_TABS: Array<{
  id: InspectorTab;
  label: string;
  icon: LucideIcon;
}> = [
  { id: 'settings', label: 'Settings', icon: Settings2 },
  { id: 'input', label: 'Input', icon: ArrowDownToLine },
  { id: 'output', label: 'Output', icon: Braces },
  { id: 'error', label: 'Error Handling', icon: AlertTriangle },
];

const TAB_DESCRIPTIONS: Record<Exclude<InspectorTab, 'settings'>, string> = {
  input: 'Data that entered this pipe on the latest debug run, keyed by upstream port.',
  output: 'Records this pipe emitted per output port (out / true / false / rejects).',
  error: 'Pipe failure from the latest debug run, plus retry settings.',
};

interface DebugIoPanelProps {
  direction: 'in' | 'out';
  data: PipeData;
  samples: DebugSample[];
  debugRunId: string | null | undefined;
  debugRunStatus: string | null | undefined;
  declaredPorts: { name: string }[];
}

function DebugIoPanel({
  direction,
  data,
  samples,
  debugRunId,
  debugRunStatus,
  declaredPorts,
}: DebugIoPanelProps) {
  const pipeSamples = useMemo(
    () => samplesForPipe(samples, data.pipelineId, data.pipeId, direction),
    [samples, data.pipelineId, data.pipeId, direction],
  );
  const portNames = useMemo(() => {
    const names = new Set<string>();
    for (const port of declaredPorts) names.add(port.name);
    for (const sample of pipeSamples) names.add(sample.port);
    if (names.size === 0) names.add(direction === 'in' ? 'in' : 'out');
    return [...names];
  }, [declaredPorts, pipeSamples, direction]);
  const [activePort, setActivePort] = useState(portNames[0] ?? 'out');

  useEffect(() => {
    if (!portNames.includes(activePort)) {
      setActivePort(portNames[0] ?? 'out');
    }
  }, [portNames, activePort]);

  const activeSamples = pipeSamples.filter((sample) => sample.port === activePort);
  const active = activeSamples[0];

  if (!debugRunId) {
    return (
      <div className="inspector-tab-placeholder">
        <Braces size={22} />
        <strong>{direction === 'in' ? 'Input' : 'Output'}</strong>
        <p>
          Run <em>Test run</em> to capture per-port samples. Multi-output pipes
          (true/false, rejects) each get their own chip.
        </p>
      </div>
    );
  }

  return (
    <div className="inspector-debug-io">
      <div className="inspector-debug-meta">
        <span>
          Run {debugRunId.slice(0, 8)}
          {debugRunStatus ? ` · ${debugRunStatus}` : ''}
        </span>
      </div>
      <div className="inspector-port-chips" role="tablist" aria-label="Ports">
        {portNames.map((port) => {
          const hit = pipeSamples.some((sample) => sample.port === port);
          return (
            <button data-testid={`workflow-inspector-sample-port-${port}`}
              key={port}
              type="button"
              role="tab"
              aria-selected={activePort === port}
              className={`inspector-port-chip${activePort === port ? ' active' : ''}${hit ? ' has-data' : ''}`}
              onClick={() => setActivePort(port)}
            >
              {portLabel(port)}
              {hit ? <small>{pipeSamples.find((s) => s.port === port)?.recordCount ?? 0}</small> : null}
            </button>
          );
        })}
      </div>
      {!active ? (
        <div className="inspector-tab-placeholder compact">
          <p>
            No sample on <strong>{portLabel(activePort)}</strong> yet
            {debugRunStatus === 'running' || debugRunStatus === 'queued'
              ? ' — run still in progress.'
              : ' — this branch did not fire.'}
          </p>
        </div>
      ) : (
        <>
          <div className="inspector-debug-meta">
            <span>
              {active.recordCount} record{active.recordCount === 1 ? '' : 's'}
              {active.truncated ? ' (truncated)' : ''}
              {active.fromPipe
                ? ` · from ${active.fromPipe}${active.fromPort ? `:${active.fromPort}` : ''}`
                : ''}
            </span>
          </div>
          <pre className="inspector-debug-json">
            {JSON.stringify(active.records, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function schemaProperties(
  configSchema: Record<string, unknown> | undefined,
): Record<string, SchemaProperty> {
  const props = configSchema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  return props as Record<string, SchemaProperty>;
}

interface InspectorHeaderProps {
  pipeId: string;
  pipeLabel: string;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
}

function InspectorHeader({
  pipeId,
  pipeLabel,
  activeTab,
  onTabChange,
}: InspectorHeaderProps) {
  return (
    <>
      <h3>Pipe Configuration</h3>
      <div className="inspector-hero">
        <span className="inspector-hero-icon">
          <Braces size={16} />
        </span>
        <div>
          <strong>{pipeId}</strong>
          <small>{pipeLabel}</small>
        </div>
      </div>
      <div className="inspector-tabs">
        {INSPECTOR_TABS.map(({ id, label, icon: Icon }) => (
          <button data-testid={`workflow-inspector-tab-${id}`}
            key={id}
            className={activeTab === id ? 'active' : ''}
            onClick={() => onTabChange(id)}
          >
            <Icon size={11} /> {label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * A JSON-valued config field with its own text buffer.
 *
 * The textarea used to render `JSON.stringify(value)` directly, so a keystroke
 * that left the text invalid — every keystroke of typing `{"a": 1}` except the
 * last — was dropped and the field snapped back. Only pasting complete JSON in
 * one go got through. The buffer keeps what was typed; only valid JSON is
 * lifted into the config.
 */
function JsonObjectField({
  name,
  value,
  onChange,
  onValidJson,
  onInvalidJson,
}: {
  name: string;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidJson: () => void;
  onInvalidJson: () => void;
}) {
  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  const [text, setText] = useState(serialized);

  // Follow changes made elsewhere — the raw JSON editor — without clobbering
  // half-typed text: adopt the incoming value only when this buffer holds
  // valid JSON that says something different.
  useEffect(() => {
    setText((current) => {
      try {
        return JSON.stringify(JSON.parse(current || '{}')) ===
          JSON.stringify(value ?? {})
          ? current
          : serialized;
      } catch {
        return current;
      }
    });
    // `value` is captured through `serialized`, which changes whenever it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  return (
    <div>
      <label>{name} (JSON)</label>
      <textarea data-testid={`workflow-inspector-json-${name}`}
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          try {
            onChange(JSON.parse(raw || '{}'));
            onValidJson();
          } catch {
            onInvalidJson();
          }
        }}
      />
    </div>
  );
}

interface ConfigFieldProps {
  name: string;
  schema: SchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidJson: () => void;
  onInvalidJson: () => void;
}

function ConfigField({
  name,
  schema,
  value,
  onChange,
  onValidJson,
  onInvalidJson,
}: ConfigFieldProps) {
  if (schema.enum) {
    return (
      <div>
        <label>{name}</label>
        <select data-testid={`workflow-inspector-field-${name}`}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <label className="checkbox-row">
        <input data-testid={`workflow-inspector-field-${name}`}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {name}
      </label>
    );
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    return (
      <div>
        <label>{name}</label>
        <input data-testid={`workflow-inspector-field-${name}`}
          type="number"
          min={schema.minimum}
          max={schema.maximum}
          value={value === '' ? '' : Number(value)}
          onChange={(event) =>
            onChange(
              event.target.value === '' ? undefined : Number(event.target.value),
            )
          }
        />
      </div>
    );
  }

  if (
    schema.type === 'object' ||
    schema.additionalProperties !== undefined
  ) {
    return (
      <JsonObjectField
        name={name}
        value={value}
        onChange={onChange}
        onValidJson={onValidJson}
        onInvalidJson={onInvalidJson}
      />
    );
  }

  return (
    <div>
      <label>{name}</label>
      <input data-testid={`workflow-inspector-field-${name}`}
        type="text"
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function Inspector({
  pipeId,
  data,
  credentials,
  categories,
  catalog,
  triggers,
  workflowId,
  workflows,
  debugRunId,
  debugSamples = [],
  debugRunStatus,
  debugRunError,
  onRename,
  onChange,
  onTriggersChange,
  onEditTrigger,
}: Props) {
  const [renameError, setRenameError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>('settings');
  const jsonEditorTheme = useJsonEditorTheme();

  const entry = useMemo(
    () => catalog.find((item) => item.type === data?.type),
    [catalog, data?.type],
  );
  const properties = useMemo(
    () => schemaProperties(entry?.configSchema),
    [entry],
  );
  const config = useMemo(
    () => (data ? parseConfig(data.config) : {}),
    [data],
  );
  const isSubWorkflow = data?.type === 'workflow.sub';
  // `triggerId` and the sub-workflow `workflowId` get dedicated pickers below,
  // so keep them out of the generic schema-driven config fields.
  const isHttpSource = data?.type === 'source.api.http';
  const isMultiHttpSource = data?.type === 'source.api.http.multi';
  // The CSV/Text sources get a dedicated editor (parsing, schema, preview)
  // covering every config key, so the generic fields stay hidden for them.
  const isDelimitedSource =
    data?.type === 'source.file.csv' || data?.type === 'source.file.text';
  // The SQL pipes' editor owns the statement text; the rest stay generic.
  const isSqlPipe = data?.type === 'source.db.sql' || data?.type === 'sink.db.sql';
  const isScriptPipe = data?.type === 'transform.script';
  const propertyKeys = Object.keys(properties).filter(
    (key) =>
      !isDelimitedSource &&
      !isMultiHttpSource &&
      !(isSqlPipe && key === 'sql') &&
      !(isScriptPipe && key === 'script') &&
      !(entry?.triggerKind && key === 'triggerId') &&
      !(isSubWorkflow && key === 'workflowId') &&
      !(isSubWorkflow && key === 'workflowVersion') &&
      !(isHttpSource && HTTP_REQUEST_KEYS.has(key)),
  );
  const subWorkflowId =
    typeof config.workflowId === 'string' ? config.workflowId : '';
  const subWorkflowVersion =
    typeof config.workflowVersion === 'number' ? config.workflowVersion : '';
  const callableWorkflows = workflows.filter(
    (workflow) =>
      workflow.id !== workflowId &&
      (workflow.callable === true ||
        workflow.triggers.some(
          (trigger) => trigger.kind === 'parent' && trigger.enabled,
        ) ||
        workflow.triggers.some((trigger) => trigger.kind === 'manual')),
  );
  const boundTriggerId =
    typeof config.triggerId === 'string' ? config.triggerId : '';
  const bindableTriggers = entry?.triggerKind
    ? triggers.filter(
        (trigger) =>
          entry.triggerKind === '*' || trigger.kind === entry.triggerKind,
      )
    : [];
  const boundTrigger = bindableTriggers.find(
    (trigger) => trigger.id === boundTriggerId,
  );

  if (!pipeId || !data) {
    return (
      <aside className="inspector">
        <h3>Parameters</h3>
        <p className="empty">
          Select a node on the canvas to edit its settings. Drag between handles
          to connect pipes.
        </p>
      </aside>
    );
  }

  const header = (
    <InspectorHeader
      pipeId={data.pipeId}
      pipeLabel={entry?.label ?? data.type}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );

  if (activeTab === 'input' || activeTab === 'output') {
    return (
      <aside className="inspector">
        {header}
        <DebugIoPanel
          direction={activeTab === 'input' ? 'in' : 'out'}
          data={data}
          samples={debugSamples}
          debugRunId={debugRunId}
          debugRunStatus={debugRunStatus}
          declaredPorts={
            activeTab === 'input' ? data.inputs : data.outputs
          }
        />
      </aside>
    );
  }

  if (activeTab === 'error') {
    return (
      <aside className="inspector">
        {header}
        <div className="inspector-debug-io">
          {debugRunError ? (
            <div className="field-error">{debugRunError}</div>
          ) : (
            <div className="inspector-tab-placeholder compact">
              <AlertTriangle size={18} />
              <p>{TAB_DESCRIPTIONS.error}</p>
              <p className="hint">
                Retry attempts: {data.retryAttempts}. Soft branches use ports
                (false / rejects); hard failures surface here after a debug run.
              </p>
            </div>
          )}
          <label>Retry attempts (0 = off)</label>
          <input data-testid="workflow-inspector-retry-attempts"
            type="number"
            min={0}
            max={20}
            value={data.retryAttempts}
            onChange={(ev) =>
              onChange(pipeId, {
                retryAttempts: Math.max(0, Number(ev.target.value) || 0),
              })
            }
          />
        </div>
      </aside>
    );
  }

  const patchConfig = (key: string, value: unknown) => {
    const next = { ...parseConfig(data.config), [key]: value };
    if (value === '' || value === undefined) delete next[key];
    onChange(pipeId, { config: JSON.stringify(next, null, 2) });
  };

  return (
    <aside className="inspector">
      {header}

      <label>Pipe id</label>
      <input data-testid="workflow-inspector-pipe-id"
        key={pipeId}
        defaultValue={data.pipeId}
        onBlur={(ev) => {
          const next = ev.target.value.trim();
          if (next === data.pipeId) return setRenameError(null);
          setRenameError(onRename(pipeId, next));
        }}
      />
      {renameError && <div className="field-error">{renameError}</div>}

      <label>Intent</label>
      <input data-testid="workflow-inspector-intent"
        value={data.intent ?? ''}
        placeholder={entry?.label ?? 'What this pipe does'}
        onChange={(ev) =>
          onChange(pipeId, {
            intent: ev.target.value.trim() || undefined,
          })
        }
      />
      <div className="hint">
        Optional one-liner for agents; defaults to the pipe type name.
      </div>

      {entry?.triggerKind && (
        <>
          <label>Workflow trigger</label>
          <select data-testid="workflow-inspector-trigger"
            value={boundTriggerId}
            onChange={(ev) => patchConfig('triggerId', ev.target.value)}
          >
            <option value="">
              {bindableTriggers.length ? 'Not bound' : 'No matching trigger'}
            </option>
            {bindableTriggers.map((trigger) => (
              <option key={trigger.id} value={trigger.id}>
                {trigger.id} ({trigger.kind})
              </option>
            ))}
          </select>
          {boundTrigger && (
            <TriggerInlineSettings
              key={boundTrigger.id}
              trigger={boundTrigger}
              credentials={credentials}
              workflows={workflows}
              currentWorkflowId={workflowId}
              onChange={(next) =>
                onTriggersChange(
                  triggers.map((trigger) =>
                    trigger.id === boundTrigger.id ? next : trigger,
                  ),
                )
              }
            />
          )}
          <button data-testid="workflow-inspector-open-in-trigger"
            type="button"
            className="linkish"
            disabled={!boundTriggerId}
            onClick={() => boundTriggerId && onEditTrigger(boundTriggerId)}
          >
            Open in trigger dialog
          </button>
          <div className="hint">
            Stored on the workflow trigger — shared with the Triggers dialog.
          </div>
        </>
      )}

      {isSubWorkflow && (
        <>
          <label>Workflow to call</label>
          <select data-testid="workflow-inspector-sub-workflow-id"
            value={subWorkflowId}
            onChange={(ev) => {
              const id = ev.target.value;
              const selected = callableWorkflows.find((w) => w.id === id);
              const next: Record<string, unknown> = {
                ...parseConfig(data.config),
              };
              if (!id) {
                delete next.workflowId;
                delete next.workflowVersion;
              } else {
                next.workflowId = id;
                if (selected) next.workflowVersion = selected.version;
              }
              onChange(pipeId, { config: JSON.stringify(next, null, 2) });
            }}
          >
            <option value="">
              {callableWorkflows.length
                ? 'Choose a workflow…'
                : 'No saved workflows'}
            </option>
            {callableWorkflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.id}
                {workflow.purpose ? ` — ${workflow.purpose}` : ''}
                {` (v${workflow.version})`}
              </option>
            ))}
            {subWorkflowId &&
              !callableWorkflows.some((w) => w.id === subWorkflowId) && (
                <option value={subWorkflowId}>
                  {subWorkflowId} (not saved)
                </option>
              )}
          </select>
          <label>Version pin</label>
          <input data-testid="workflow-inspector-sub-workflow-version"
            type="number"
            min={1}
            placeholder="latest"
            value={subWorkflowVersion}
            onChange={(ev) => {
              const raw = ev.target.value.trim();
              patchConfig(
                'workflowVersion',
                raw ? Math.max(1, Number(raw) || 1) : undefined,
              );
            }}
          />
          <div className="hint">
            Prefer workflows with a parent trigger. Pin a version so callers
            keep a stable procedure; omit to use latest.
          </div>
        </>
      )}

      {!entry?.simple && (
        <>
          <label>Type</label>
          <select data-testid="workflow-inspector-type"
            value={data.type}
            onChange={(ev) => {
              const selected = catalog.find((e) => e.type === ev.target.value);
              if (selected) {
                onChange(pipeId, { type: selected.type, role: selected.role });
              }
            }}
          >
            {categories.map((category) => (
              <optgroup key={category.id} label={category.label}>
                {category.entries.map((e) => (
                  <option key={e.type} value={e.type}>
                    {e.label} ({e.type})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <label htmlFor="pipe-credential">Credential</label>
          <FilterPicker
            id="pipe-credential"
            mode="single"
            testId="pipe-credential"
            options={credentials.map((c) => ({
              id: c.id,
              label: c.name,
              badge: c.kind,
              detail: c.source ? `${c.id} · ${c.source}` : c.id,
              testId: `pipe-credential-option-${c.id}`,
            }))}
            selectedId={data.credentialId || null}
            onSelect={(credentialId) => onChange(pipeId, { credentialId })}
            clearLabel="none"
            placeholder="Filter by name, kind, id…"
            summary={credentialSummary(credentials, data.credentialId)}
          />

          <label>Concurrency (×N workers)</label>
          <input data-testid="workflow-inspector-concurrency"
            type="number"
            min={1}
            max={64}
            value={data.concurrency}
            onChange={(ev) =>
              onChange(pipeId, { concurrency: Math.max(1, Number(ev.target.value) || 1) })
            }
          />

          <label>Retry attempts (0 = off)</label>
          <input data-testid="workflow-inspector-http-retry-attempts"
            type="number"
            min={0}
            max={20}
            value={data.retryAttempts}
            onChange={(ev) =>
              onChange(pipeId, { retryAttempts: Math.max(0, Number(ev.target.value) || 0) })
            }
          />
        </>
      )}

      {isHttpSource && (
        <>
          <h4 className="inspector-section">HTTP request</h4>
          <HttpRequestEditor
            // Remount per node: the editor keeps local buffers (body JSON,
            // Zod schema, test data) that must never bleed across pipes.
            key={pipeId}
            value={toHttpRequestValue(config)}
            credentials={credentials}
            onChange={(request: HttpRequestValue) => {
              const next: Record<string, unknown> = {
                ...parseConfig(data.config),
                ...request,
              };
              delete next.request;
              onChange(pipeId, { config: JSON.stringify(next, null, 2) });
              setConfigError(null);
            }}
          />
        </>
      )}

      {isDelimitedSource && (
        <>
          <h4 className="inspector-section">
            {data.type === 'source.file.csv' ? 'CSV source' : 'Text source'}
          </h4>
          <DelimitedSourceEditor
            // Remount per node: the editor keeps local buffers (Zod code,
            // sample text, preview) that must never bleed across pipes.
            key={pipeId}
            kind={data.type === 'source.file.csv' ? 'csv' : 'text'}
            config={config}
            onChange={(next) => {
              onChange(pipeId, { config: JSON.stringify(next, null, 2) });
              setConfigError(null);
            }}
          />
        </>
      )}

      {isMultiHttpSource && (
        <>
          <h4 className="inspector-section">Parallel HTTP endpoints</h4>
          <MultiHttpEditor
            key={pipeId}
            config={config}
            credentials={credentials}
            onChange={(next) => {
              onChange(pipeId, { config: JSON.stringify(next, null, 2) });
              setConfigError(null);
            }}
          />
        </>
      )}

      {isSqlPipe && (
        <>
          <h4 className="inspector-section">
            {data.type === 'sink.db.sql' ? 'SQL write' : 'SQL query'}
          </h4>
          <SqlPipeEditor
            key={pipeId}
            type={data.type as SqlPipeType}
            config={config}
            credentialId={data.credentialId}
            onConfigChange={(next) => {
              onChange(pipeId, { config: JSON.stringify(next, null, 2) });
              setConfigError(null);
            }}
            onCredentialChange={(credentialId) => onChange(pipeId, { credentialId })}
          />
        </>
      )}

      {isScriptPipe && (
        <>
          <h4 className="inspector-section">Script</h4>
          <div className="monaco-frame">
            <Editor
              height="220px"
              language="javascript"
              theme={jsonEditorTheme}
              value={typeof config.script === 'string' ? config.script : ''}
              onChange={(value) => patchConfig('script', value ?? '')}
              options={{ ...JSON_EDITOR_OPTIONS, lineNumbers: 'on' }}
            />
          </div>
          <div className="hint">
            The body of a function that receives <code>records</code> and returns the new array. It runs in
            an isolated process with no file, network or environment access, and its <code>console.log</code>{' '}
            lines appear in the run log.
          </div>
        </>
      )}

      {propertyKeys.length > 0 && (
        <>
          <h4 className="inspector-section">
            {isHttpSource ? 'Response' : 'Config'}
          </h4>
          {propertyKeys.map((key) => {
            const schema = properties[key]!;
            const value = config[key] ?? schema.default ?? '';

            return (
              <ConfigField
                // Keyed by pipe as well as field: JSON fields hold a text
                // buffer that must not carry over to another pipe's config.
                key={`${pipeId}:${key}`}
                name={key}
                schema={schema}
                value={value}
                onChange={(nextValue) => patchConfig(key, nextValue)}
                onValidJson={() => setConfigError(null)}
                onInvalidJson={() => setConfigError(`${key}: invalid JSON`)}
              />
            );
          })}
        </>
      )}

      {!entry?.simple && (
        <>
          <button data-testid="workflow-inspector-show-raw"
            type="button"
            className="linkish"
            onClick={() => setShowRaw((open) => !open)}
          >
            {showRaw ? 'Hide raw JSON' : 'Edit raw JSON'}
          </button>
          {showRaw && (
            <>
              <label>Config (JSON)</label>
              <div className="monaco-frame">
                <Editor
                  height="220px"
                  language="json"
                  theme={jsonEditorTheme}
                  value={data.config}
                  onChange={(value) => {
                    const next = value ?? '';
                    onChange(pipeId, { config: next });
                    try {
                      JSON.parse(next || '{}');
                      setConfigError(null);
                    } catch {
                      setConfigError('Not valid JSON — fix before validating or saving.');
                    }
                  }}
                  options={JSON_EDITOR_OPTIONS}
                />
              </div>
            </>
          )}
        </>
      )}
      {configError ? (
        <div className="field-error">{configError}</div>
      ) : (
        <div className="hint">
          {entry
            ? `${entry.type} v${entry.version}${
                entry.provider && entry.provider.origin !== 'builtin'
                  ? ` · ${entry.provider.package ?? entry.provider.namespace}`
                  : ''
              }`
            : 'Pipe-specific options, validated by the pipe implementation.'}
        </div>
      )}
    </aside>
  );
}
