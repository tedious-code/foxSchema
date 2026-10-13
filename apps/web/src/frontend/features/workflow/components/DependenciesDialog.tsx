/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/DependenciesDialog.tsx).
 */
import { GitBranch, Plus, Save, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, Label, Select } from './controls';

export type WorkflowDependency = {
  from: string;
  to: string;
  on: 'success' | 'failure' | 'always';
};

type PipelineOption = {
  id: string;
  name: string;
};

interface Props {
  pipelines: PipelineOption[];
  dependencies: WorkflowDependency[];
  onApply: (dependencies: WorkflowDependency[]) => void;
  onClose: () => void;
}

const ON_OPTIONS: Array<{ value: WorkflowDependency['on']; label: string }> = [
  { value: 'success', label: 'On success' },
  { value: 'failure', label: 'On failure' },
  { value: 'always', label: 'Always' },
];

/** Rough wave preview: pipelines with no unmet deps start together. */
function previewWaves(
  pipelines: PipelineOption[],
  dependencies: WorkflowDependency[],
): string[][] {
  const ids = pipelines.map((pipeline) => pipeline.id);
  const remaining = new Set(ids);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) =>
      dependencies
        .filter((dep) => dep.to === id)
        .every((dep) => !remaining.has(dep.from)),
    );
    if (ready.length === 0) {
      // Cycle or bad edge — dump the rest as one wave so the UI still shows something.
      waves.push([...remaining]);
      break;
    }
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
  }
  return waves;
}

function formatWave(
  wave: string[],
  pipelines: PipelineOption[],
): string {
  return wave
    .map(
      (id) =>
        pipelines.find((pipeline) => pipeline.id === id)?.name ?? id,
    )
    .join(' + ');
}

function PipelineSelect({
  value,
  pipelines,
  onChange,
}: {
  value: string;
  pipelines: PipelineOption[];
  onChange: (pipelineId: string) => void;
}) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {pipelines.map((pipeline) => (
        <option key={pipeline.id} value={pipeline.id}>
          {pipeline.name}
        </option>
      ))}
    </Select>
  );
}

/** Mounted only while open, so the draft starts from the current joins each time. */
export function DependenciesDialog({
  pipelines,
  dependencies,
  onApply,
  onClose,
}: Props) {
  const [draft, setDraft] = useState<WorkflowDependency[]>(dependencies);
  const [error, setError] = useState<string | null>(null);

  const waves = useMemo(
    () => previewWaves(pipelines, draft),
    [pipelines, draft],
  );


  const addRow = () => {
    if (pipelines.length < 2) {
      setError('Add at least two pipelines before creating a join.');
      return;
    }
    const from = pipelines[0]!.id;
    const to =
      pipelines.find((pipeline) => pipeline.id !== from)?.id ?? pipelines[1]!.id;
    setDraft((current) => [...current, { from, to, on: 'success' }]);
    setError(null);
  };

  const apply = () => {
    const pairs = new Set<string>();
    for (const dep of draft) {
      if (dep.from === dep.to) {
        setError('A pipeline cannot depend on itself.');
        return;
      }
      if (!pipelines.some((pipeline) => pipeline.id === dep.from)) {
        setError(`Unknown upstream pipeline: ${dep.from}`);
        return;
      }
      if (!pipelines.some((pipeline) => pipeline.id === dep.to)) {
        setError(`Unknown downstream pipeline: ${dep.to}`);
        return;
      }
      const key = `${dep.from}->${dep.to}`;
      if (pairs.has(key)) {
        setError(`Duplicate dependency ${dep.from} → ${dep.to}.`);
        return;
      }
      pairs.add(key);
    }
    onApply(draft);
    onClose();
  };

  return (
    <div className="trigger-dialog-backdrop" role="presentation">
      <section
        className="trigger-dialog dependencies-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Pipeline dependencies"
      >
        <header className="trigger-dialog-titlebar">
          <div className="trigger-title">
            <span className="trigger-title-icon">
              <GitBranch size={19} />
            </span>
            <div>
              <h2>Pipeline joins</h2>
              <p>
                Run pipelines in parallel, then wait for all upstream ones to
                finish before starting the next.
              </p>
            </div>
          </div>
          <div className="trigger-dialog-actions">
            <Button variant="primary" onClick={apply}>
              <Save /> Apply
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close"
            >
              <X />
            </Button>
          </div>
        </header>

        <div className="workflow-settings-body">
          <div className="deps-help">
            Example: <code>fetchUsers</code> + <code>fetchOrders</code> →{' '}
            <code>continue</code> means both HTTP pipelines run together, and{' '}
            <code>continue</code> starts only after both succeed.
          </div>

          {draft.length === 0 ? (
            <p className="empty deps-empty">
              No joins yet. Pipelines without dependencies all start together.
            </p>
          ) : (
            <div className="deps-rows">
              {draft.map((dep, index) => {
                const patchRow = (patch: Partial<WorkflowDependency>) =>
                  setDraft((current) =>
                    current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
                  );
                return (
                  <div key={`${dep.from}-${dep.to}-${index}`} className="deps-row">
                    <div>
                      <Label>From (upstream)</Label>
                      <PipelineSelect
                        value={dep.from}
                        pipelines={pipelines}
                        onChange={(from) => patchRow({ from })}
                      />
                    </div>
                    <div>
                      <Label>To (waits)</Label>
                      <PipelineSelect
                        value={dep.to}
                        pipelines={pipelines}
                        onChange={(to) => patchRow({ to })}
                      />
                    </div>
                    <div>
                      <Label>When</Label>
                      <Select
                        value={dep.on}
                        onChange={(event) =>
                          patchRow({ on: event.target.value as WorkflowDependency['on'] })
                        }
                      >
                        {ON_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove dependency"
                      onClick={() =>
                        setDraft((current) => current.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="deps-actions">
            <Button onClick={addRow} disabled={pipelines.length < 2}>
              <Plus /> Add join
            </Button>
          </div>

          {error && <div className="field-error">{error}</div>}

          {pipelines.length > 0 && (
            <div className="deps-waves">
              <Label>Run order preview</Label>
              <ol>
                {waves.map((wave, index) => (
                  <li key={index}>
                    <span className="deps-wave-index">Wave {index + 1}</span>
                    {formatWave(wave, pipelines)}
                    {wave.length > 1 ? (
                      <small> — parallel, then wait</small>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
