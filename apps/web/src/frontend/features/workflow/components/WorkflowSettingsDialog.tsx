/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/WorkflowSettingsDialog.tsx).
 */
import Editor from '@monaco-editor/react';
import {
  ArrowDown,
  ArrowUp,
  Layers,
  Plus,
  Save,
  Settings2,
  Trash2,
  Variable,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { MiddlewareMeta } from '../api/engineClient';
import { useEnvironments, useVariables } from '../api/engineQueries';
import { JSON_EDITOR_OPTIONS, useJsonEditorTheme } from '../lib/jsonEditorOptions';
import { Button, Input, Label, Select, Textarea } from './controls';
import { VariableTable } from './VariablesPanel';

export interface MiddlewareRef {
  name: string;
  config: Record<string, unknown>;
}

/** Workflow-level settings the dialog edits (all optional except middleware). */
export interface WorkflowSettings {
  description?: string;
  /** Why this workflow exists — agent/human retrieval (Agentic OS). */
  purpose?: string;
  tags?: string[];
  /** Short prose of expected outcome (hard contract remains outputSchema). */
  expectedResult?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  middleware: MiddlewareRef[];
}

interface Props {
  /** Current workflow id — used for workflow-scoped variables. */
  workflowId: string;
  settings: WorkflowSettings;
  /** Registered middleware names from GET /api/middleware. */
  middlewareCatalog: MiddlewareMeta[];
  onApply: (settings: WorkflowSettings) => void;
  onClose: () => void;
}

type MiddlewareRow = {
  uid: number;
  name: string;
  configText: string;
};

type SchemaDraft = { text: string; error: string | null };

function schemaDraft(schema: Record<string, unknown> | undefined): SchemaDraft {
  return {
    text: schema === undefined ? '' : JSON.stringify(schema, null, 2),
    error: null,
  };
}

/** Parse a schema buffer: empty → undefined, else a JSON object. */
function parseSchemaText(
  text: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function SchemaEditor({
  label,
  help,
  draft,
  onChange,
}: {
  label: string;
  help: string;
  draft: SchemaDraft;
  onChange: (draft: SchemaDraft) => void;
}) {
  const jsonEditorTheme = useJsonEditorTheme();
  return (
    <div className="span-2">
      <Label>{label}</Label>
      <div className="monaco-frame">
        <Editor
          height="160px"
          language="json"
          theme={jsonEditorTheme}
          value={draft.text}
          onChange={(next) => {
            const text = next ?? '';
            onChange({
              text,
              error: parseSchemaText(text).ok
                ? null
                : 'Must be a JSON object (or empty for none).',
            });
          }}
          options={JSON_EDITOR_OPTIONS}
        />
      </div>
      {draft.error ? (
        <div className="field-error">{draft.error}</div>
      ) : (
        <small className="form-help">{help}</small>
      )}
    </div>
  );
}

/**
 * Workflow-level settings: description, input/output JSON Schemas, workflow
 * variables, and the ordered control-plane middleware chain. Edits a local
 * draft for document fields; nothing touches the workflow until Apply, so
 * half-typed JSON can never corrupt state. Variables save immediately (same
 * as the global Variables panel).
 */
export function WorkflowSettingsDialog({
  workflowId,
  settings,
  middlewareCatalog,
  onApply,
  onClose,
}: Props) {
  // Mounted only while open, so each draft starts from the applied settings.
  // A dozen setters in an effect used to reset them, keyed to prop identity.
  const uidRef = useRef(1);
  const [description, setDescription] = useState(settings.description ?? '');
  const [purpose, setPurpose] = useState(settings.purpose ?? '');
  const [tagsText, setTagsText] = useState((settings.tags ?? []).join(', '));
  const [expectedResult, setExpectedResult] = useState(settings.expectedResult ?? '');
  const [inputDraft, setInputDraft] = useState<SchemaDraft>(() => schemaDraft(settings.inputSchema));
  const [outputDraft, setOutputDraft] = useState<SchemaDraft>(() => schemaDraft(settings.outputSchema));
  const [rows, setRows] = useState<MiddlewareRow[]>(() =>
    settings.middleware.map((ref) => ({
      uid: uidRef.current++,
      name: ref.name,
      configText: Object.keys(ref.config).length === 0 ? '' : JSON.stringify(ref.config, null, 2),
    })),
  );
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [addName, setAddName] = useState('');
  // Empty means "the active environment" — `selectedEnv` falls back to it.
  const [envId, setEnvId] = useState('');

  const { environments } = useEnvironments();
  const activeEnv = environments.find((environment) => environment.isActive);
  const selectedEnv =
    environments.find((environment) => environment.id === envId) ?? activeEnv;

  const { variables: workflowVars, refresh: refreshWorkflowVars } = useVariables(selectedEnv?.id, {
    scope: 'workflow',
    workflowId,
  });
  const { variables: globalVars } = useVariables(selectedEnv?.id, { scope: 'global' });


  const patchRow = (uid: number, patch: Partial<MiddlewareRow>) => {
    setRows((current) =>
      current.map((row) => (row.uid === uid ? { ...row, ...patch } : row)),
    );
  };

  const moveRow = (uid: number, delta: -1 | 1) => {
    setRows((current) => {
      const index = current.findIndex((row) => row.uid === uid);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const apply = () => {
    const input = parseSchemaText(inputDraft.text);
    const output = parseSchemaText(outputDraft.text);
    const errors: Record<number, string> = {};
    const middleware: MiddlewareRef[] = [];
    for (const row of rows) {
      const config = parseSchemaText(row.configText);
      if (!config.ok) {
        errors[row.uid] = 'Config must be a JSON object (or empty).';
        continue;
      }
      middleware.push({ name: row.name, config: config.value ?? {} });
    }
    setRowErrors(errors);
    if (!input.ok || !output.ok || Object.keys(errors).length > 0) {
      if (!input.ok) setInputDraft((d) => ({ ...d, error: 'Must be a JSON object (or empty for none).' }));
      if (!output.ok) setOutputDraft((d) => ({ ...d, error: 'Must be a JSON object (or empty for none).' }));
      return;
    }
    const trimmed = description.trim();
    const purposeTrimmed = purpose.trim();
    const expectedTrimmed = expectedResult.trim();
    const tags = tagsText
      .split(/[,;\n]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 32);
    onApply({
      ...(trimmed ? { description: trimmed } : {}),
      ...(purposeTrimmed ? { purpose: purposeTrimmed } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(expectedTrimmed ? { expectedResult: expectedTrimmed } : {}),
      ...(input.value !== undefined ? { inputSchema: input.value } : {}),
      ...(output.value !== undefined ? { outputSchema: output.value } : {}),
      middleware,
    });
    onClose();
  };

  const addOptions = middlewareCatalog.map((meta) => meta.name);

  return (
    <div className="trigger-dialog-backdrop" role="presentation">
      <section
        className="trigger-dialog workflow-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Workflow settings"
      >
        <header className="trigger-dialog-titlebar">
          <div className="trigger-title">
            <span className="trigger-title-icon"><Settings2 size={19} /></span>
            <div>
              <h2>Workflow settings</h2>
              <p>Purpose, contracts, variables, and middleware.</p>
            </div>
          </div>
          <div className="trigger-dialog-actions">
            <Button variant="primary" onClick={apply}>
              <Save /> Apply
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>
        </header>

        <div className="workflow-settings-body">
          <div className="trigger-form-grid">
            <div className="span-2">
              <Label>Purpose</Label>
              <Textarea
                rows={2}
                value={purpose}
                placeholder="Why this workflow exists — used for catalog reuse and agents."
                onChange={(event) => setPurpose(event.target.value)}
              />
              <small className="form-help">
                Prefer purpose over scraping pipe configs when searching for reusable
                procedures.
              </small>
            </div>

            <div className="span-2">
              <Label>Tags</Label>
              <Input
                value={tagsText}
                placeholder="login, seo, billing (comma-separated)"
                onChange={(event) => setTagsText(event.target.value)}
              />
            </div>

            <div className="span-2">
              <Label>Expected result</Label>
              <Textarea
                rows={2}
                value={expectedResult}
                placeholder="Short prose of the expected outcome. Hard contract remains output schema."
                onChange={(event) => setExpectedResult(event.target.value)}
              />
            </div>

            <div className="span-2">
              <Label>Description</Label>
              <Textarea
                rows={2}
                value={description}
                placeholder="Optional longer notes for humans."
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <SchemaEditor
              label="Input schema (JSON Schema)"
              help="Validated against the run payload at admission — manual, webhook, and HTTP triggers get a 400 on mismatch. Empty accepts anything."
              draft={inputDraft}
              onChange={setInputDraft}
            />
            <SchemaEditor
              label="Output schema (JSON Schema)"
              help="Documents the records this workflow produces, e.g. for sub-workflow callers. Empty for none."
              draft={outputDraft}
              onChange={setOutputDraft}
            />

            <div className="span-2 workflow-variables-section">
              <Label>
                <Variable size={11} /> Workflow variables
              </Label>
              <small className="form-help">
                Overrides globals with the same name for this workflow (
                <code>{workflowId}</code>). Available as{' '}
                <code>{'{{vars.name}}'}</code>. Saved immediately — not gated by
                Apply.
              </small>
              {environments.length === 0 ? (
                <p className="empty">
                  Create an environment under Variables in the sidebar first.
                </p>
              ) : (
                <>
                  <div className="workflow-variables-env">
                    <Label>Environment</Label>
                    <Select
                      aria-label="Environment for workflow variables"
                      value={selectedEnv?.id ?? ''}
                      onChange={(event) => setEnvId(event.target.value)}
                    >
                      {environments.map((environment) => (
                        <option key={environment.id} value={environment.id}>
                          {environment.name}
                          {environment.isActive ? ' (active)' : ''}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {selectedEnv && (
                    <VariableTable
                      title={`Local — ${workflowId}`}
                      description="Overrides a global with the same name in this environment."
                      scope="workflow"
                      workflowId={workflowId}
                      environment={selectedEnv}
                      environments={environments}
                      variables={workflowVars}
                      onChanged={refreshWorkflowVars}
                      shadowed={new Set(globalVars.map((variable) => variable.key))}
                    />
                  )}
                </>
              )}
            </div>

            <div className="span-2">
              <Label>
                <Layers size={11} /> Middleware (runs in order)
              </Label>
              {rows.length === 0 && (
                <small className="form-help">
                  No middleware — runs execute directly. Add registered
                  middleware to wrap admission, workflow, and pipeline phases.
                </small>
              )}
              {rows.map((row, index) => {
                const meta = middlewareCatalog.find(
                  (item) => item.name === row.name,
                );
                return (
                  <div key={row.uid} className="middleware-row">
                    <div className="middleware-row-head">
                      <span className="middleware-row-order">{index + 1}</span>
                      <strong>{row.name}</strong>
                      <small>
                        {meta ? meta.tiers.join(' · ') : 'not registered'}
                      </small>
                      <span className="middleware-row-actions">
                        <Button
                          size="icon"
                          aria-label="Move up"
                          onClick={() => moveRow(row.uid, -1)}
                          disabled={index === 0}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          size="icon"
                          aria-label="Move down"
                          onClick={() => moveRow(row.uid, 1)}
                          disabled={index === rows.length - 1}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          size="icon"
                          aria-label={`Remove ${row.name}`}
                          onClick={() =>
                            setRows((current) =>
                              current.filter((item) => item.uid !== row.uid),
                            )
                          }
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    </div>
                    <Textarea
                      rows={2}
                      value={row.configText}
                      placeholder='Config (JSON), e.g. { "prefix": "orders" }'
                      onChange={(event) =>
                        patchRow(row.uid, { configText: event.target.value })
                      }
                    />
                    {rowErrors[row.uid] && (
                      <div className="field-error">{rowErrors[row.uid]}</div>
                    )}
                  </div>
                );
              })}
              <div className="middleware-add">
                <Select
                  aria-label="Middleware to add"
                  value={addName}
                  onChange={(event) => setAddName(event.target.value)}
                >
                  <option value="">
                    {addOptions.length ? 'Choose middleware…' : 'None registered'}
                  </option>
                  {addOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
                <Button
                  onClick={() => {
                    if (!addName) return;
                    setRows((current) => [
                      ...current,
                      { uid: uidRef.current++, name: addName, configText: '' },
                    ]);
                    setAddName('');
                  }}
                  disabled={!addName}
                >
                  <Plus /> Add
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
