/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/VariablesPanel.tsx).
 */
import { Check, Copy, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from '../lib/notify';
import { api, type EnvironmentMeta, type VariableScope } from '../api/engineClient';
import { useEnvironments, useVariables } from '../api/engineQueries';
import { Button, Input } from './controls';

/**
 * Environments and **global** variables (shared across workflows).
 * Workflow-scoped overrides live in Workflow settings for the open workflow.
 */
export function VariablesPanel() {
  const { environments, refresh: refreshEnvironments } = useEnvironments();
  const [selectedId, setSelectedId] = useState<string>('');
  const [newEnvName, setNewEnvName] = useState('');

  const active = environments.find((environment) => environment.isActive);
  const selected =
    environments.find((environment) => environment.id === selectedId) ?? active;

  const { variables, refresh: refreshVariables } = useVariables(selected?.id, {
    scope: 'global',
  });
  const refreshAll = () => {
    refreshEnvironments();
    refreshVariables();
  };

  const createEnvironment = async () => {
    const name = newEnvName.trim();
    if (!name) return;
    try {
      const created = await api.createEnvironment(name);
      setNewEnvName('');
      setSelectedId(created.id);
      refreshAll();
      toast.success(`Environment "${name}" created`);
    } catch (error) {
      toast.error('Create failed', { description: (error as Error).message });
    }
  };

  const activate = async (environment: EnvironmentMeta) => {
    try {
      await api.activateEnvironment(environment.id);
      refreshAll();
      toast.success(`"${environment.name}" is now the active environment`);
    } catch (error) {
      toast.error('Activate failed', { description: (error as Error).message });
    }
  };

  const removeEnvironment = async (environment: EnvironmentMeta) => {
    if (
      !window.confirm(
        `Delete environment "${environment.name}" and all its variables?`,
      )
    ) {
      return;
    }
    try {
      await api.deleteEnvironment(environment.id);
      if (selectedId === environment.id) setSelectedId('');
      refreshAll();
      toast.success(`Environment "${environment.name}" deleted`);
    } catch (error) {
      toast.error('Delete failed', { description: (error as Error).message });
    }
  };

  return (
    <div className="variables-panel">
      <header className="variables-header">
        <div>
          <h3>Global variables</h3>
          <p>
            Shared across workflows as <code>{'{{vars.name}}'}</code>. Per-workflow
            overrides live in <strong>Workflow settings</strong> for the open
            workflow.
          </p>
        </div>
        <div className="variables-new-env">
          <Input
            value={newEnvName}
            placeholder="New environment (e.g. staging)"
            onChange={(event) => setNewEnvName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void createEnvironment();
            }}
          />
          <Button onClick={createEnvironment} disabled={!newEnvName.trim()}>
            <Plus /> Add
          </Button>
        </div>
      </header>

      {environments.length === 0 ? (
        <p className="empty">
          No environments yet. Create one (dev, staging, prod…) to start
          defining global variables.
        </p>
      ) : (
        <>
          <div className="environment-tabs" role="tablist">
            {environments.map((environment) => (
              <button data-testid={`workflow-variables-environment-${environment.id}`}
                key={environment.id}
                role="tab"
                aria-selected={environment.id === selected?.id}
                className={environment.id === selected?.id ? 'active' : ''}
                onClick={() => setSelectedId(environment.id)}
              >
                {environment.name}
                {environment.isActive && (
                  <span className="env-active-dot" title="Active environment">
                    <Star size={9} />
                  </span>
                )}
              </button>
            ))}
          </div>

          {selected && (
            <div className="environment-actions">
              {selected.isActive ? (
                <span className="hint">
                  <Check size={11} /> Runs use <strong>{selected.name}</strong>{' '}
                  unless a run overrides it.
                </span>
              ) : (
                <Button onClick={() => activate(selected)}>
                  <Star /> Make active
                </Button>
              )}
              <Button
                size="icon"
                aria-label={`Delete ${selected.name}`}
                onClick={() => removeEnvironment(selected)}
              >
                <Trash2 />
              </Button>
            </div>
          )}

          {selected && (
            <VariableTable
              title="Global"
              description="Every workflow in this environment."
              scope="global"
              environment={selected}
              environments={environments}
              variables={variables}
              onChanged={refreshVariables}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Editable key/value table for one variable scope (global or workflow). */
export function VariableTable({
  title,
  description,
  scope,
  workflowId,
  environment,
  environments,
  variables,
  onChanged,
  shadowed,
}: {
  title: string;
  description: string;
  scope: VariableScope;
  workflowId?: string;
  environment: EnvironmentMeta;
  environments: EnvironmentMeta[];
  variables: { id: string; key: string; value: unknown }[];
  onChanged: () => void;
  shadowed?: Set<string>;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const parseValue = (raw: string): unknown => {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return raw;
    }
  };

  const add = async () => {
    const name = key.trim();
    if (!name) return;
    try {
      await api.putVariable(environment.id, {
        scope,
        ...(workflowId ? { workflowId } : {}),
        key: name,
        value: parseValue(value),
      });
      setKey('');
      setValue('');
      onChanged();
    } catch (error) {
      toast.error('Save failed', { description: (error as Error).message });
    }
  };

  const save = async (name: string, raw: string) => {
    try {
      await api.putVariable(environment.id, {
        scope,
        ...(workflowId ? { workflowId } : {}),
        key: name,
        value: parseValue(raw),
      });
      onChanged();
    } catch (error) {
      toast.error('Save failed', { description: (error as Error).message });
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteVariable(id);
      onChanged();
    } catch (error) {
      toast.error('Delete failed', { description: (error as Error).message });
    }
  };

  const clone = async (name: string) => {
    const targets = environments
      .filter((candidate) => candidate.id !== environment.id)
      .map((candidate) => candidate.id);
    if (targets.length === 0) {
      toast.error('No other environment to clone into');
      return;
    }
    try {
      const result = await api.cloneVariable({
        sourceEnvironmentId: environment.id,
        targetEnvironmentIds: targets,
        scope,
        ...(workflowId ? { workflowId } : {}),
        key: name,
      });
      const cloned = result.cloned.length;
      const skipped = result.skipped.length;
      toast.success(
        `"${name}" cloned into ${cloned} environment${cloned === 1 ? '' : 's'}`,
        skipped
          ? {
              description: `${skipped} already had this name and were left alone.`,
            }
          : undefined,
      );
      onChanged();
    } catch (error) {
      toast.error('Clone failed', { description: (error as Error).message });
    }
  };

  return (
    <section className="variable-table">
      <div className="variable-table-head">
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      {variables.length === 0 && (
        <p className="empty">No variables in this scope yet.</p>
      )}
      {variables.map((variable) => (
        <div key={variable.id} className="variable-row">
          <span className="variable-key">
            {variable.key}
            {shadowed?.has(variable.key) && (
              <small className="variable-shadow" title="Overrides a global">
                overrides global
              </small>
            )}
          </span>
          <Input
            defaultValue={
              typeof variable.value === 'string'
                ? variable.value
                : JSON.stringify(variable.value)
            }
            onBlur={(event) => {
              const next = event.target.value;
              const current =
                typeof variable.value === 'string'
                  ? variable.value
                  : JSON.stringify(variable.value);
              if (next !== current) void save(variable.key, next);
            }}
          />
          <Button
            size="icon"
            aria-label={`Clone ${variable.key} to other environments`}
            title="Clone this name into the other environments"
            onClick={() => clone(variable.key)}
          >
            <Copy />
          </Button>
          <Button
            size="icon"
            aria-label={`Delete ${variable.key}`}
            onClick={() => remove(variable.id)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="variable-row variable-row-new">
        <Input
          value={key}
          placeholder="name"
          onChange={(event) => setKey(event.target.value)}
        />
        <Input
          value={value}
          placeholder='value (JSON ok: 100, true, {"a":1})'
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
        />
        <Button onClick={add} disabled={!key.trim()}>
          <Plus /> Add
        </Button>
      </div>
    </section>
  );
}
