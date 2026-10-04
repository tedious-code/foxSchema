/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/WorkflowsPanel.tsx).
 */
import { Copy, Download, FilePlus2, PlayCircle, Search, Trash2, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from '../lib/notify';
import { api, type WorkflowPackage, type WorkflowSummary } from '../api/engineClient';
import { useWorkflows } from '../api/engineQueries';
import { Button, Input } from './controls';

interface Props {
  /** Currently open workflow, highlighted in the list. */
  currentId: string;
  /** Load a workflow into the designer canvas. */
  onOpen: (id: string) => void;
  /** Start a blank workflow under a new id. */
  onCreate: (id: string) => void;
}

function relativeTime(iso?: string): string {
  if (!iso) return '—';
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return '—';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Workflow browser: open, duplicate, delete, and create. */
export function WorkflowsPanel({
  currentId,
  onOpen,
  onCreate,
}: Props) {
  const { workflows, loading, refresh } = useWorkflows();
  const [query, setQuery] = useState('');
  const [newId, setNewId] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workflows;
    return workflows.filter(
      (workflow) =>
        workflow.id.toLowerCase().includes(needle) ||
        workflow.name.toLowerCase().includes(needle) ||
        (workflow.description ?? '').toLowerCase().includes(needle) ||
        (workflow.purpose ?? '').toLowerCase().includes(needle) ||
        (workflow.tags ?? []).some((tag) => tag.toLowerCase().includes(needle)),
    );
  }, [workflows, query]);

  const create = () => {
    const id = newId.trim();
    if (!id) return;
    if (workflows.some((workflow) => workflow.id === id)) {
      toast.error(`"${id}" already exists`);
      return;
    }
    setNewId('');
    onCreate(id);
  };

  const duplicate = async (workflow: WorkflowSummary) => {
    let candidate = `${workflow.id}-copy`;
    let suffix = 2;
    while (workflows.some((existing) => existing.id === candidate)) {
      candidate = `${workflow.id}-copy-${suffix++}`;
    }
    try {
      await api.duplicateWorkflow(workflow.id, { id: candidate });
      refresh();
      toast.success(`Duplicated to "${candidate}"`);
    } catch (error) {
      toast.error('Duplicate failed', { description: (error as Error).message });
    }
  };

  const remove = async (workflow: WorkflowSummary) => {
    if (
      !window.confirm(
        `Delete workflow "${workflow.id}"? Run history is kept, but the definition and its workflow-scoped variables are removed.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteWorkflow(workflow.id);
      refresh();
      toast.success(`Deleted "${workflow.id}"`, {
        description: 'Run history is kept — runs carry their own snapshot.',
      });
    } catch (error) {
      // The API refuses while a run is active; surface that verbatim.
      toast.error('Delete failed', { description: (error as Error).message });
    }
  };

  const exportPackage = async (workflow: WorkflowSummary) => {
    try {
      const pkg = await api.exportWorkflow(workflow.id);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${workflow.id}.foxflow.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported "${workflow.id}"`);
    } catch (error) {
      toast.error('Export failed', { description: (error as Error).message });
    }
  };

  const importPackage = async (file: File) => {
    try {
      const text = await file.text();
      const pkg = JSON.parse(text) as WorkflowPackage;
      const override = window.prompt(
        'Import workflow id (leave blank to keep package id):',
        pkg.workflow &&
          typeof pkg.workflow === 'object' &&
          'id' in pkg.workflow &&
          typeof (pkg.workflow as { id: unknown }).id === 'string'
          ? (pkg.workflow as { id: string }).id
          : '',
      );
      if (override === null) return;
      await api.importWorkflow({
        package: pkg,
        ...(override.trim() ? { workflowId: override.trim() } : {}),
      });
      refresh();
      toast.success('Imported workflow package');
    } catch (error) {
      toast.error('Import failed', { description: (error as Error).message });
    }
  };

  return (
    <div className="workflows-panel">
      <header className="workflows-header">
        <div>
          <h3>Workflows</h3>
          <p>{workflows.length} saved</p>
        </div>
        <div className="workflows-actions">
          {/* Utilities, not workflow.css: that sheet is in @layer components,
              which Input's own w-full/px-2.5 utilities outrank — so the icon
              sat on top of the placeholder in a box too narrow to read. */}
          <div className="workflows-search w-52 shrink-0">
            <Search size={13} />
            <Input
              className="pl-7"
              value={query}
              placeholder="Search workflows…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Input
            value={newId}
            placeholder="new-workflow-id"
            onChange={(event) => setNewId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') create();
            }}
          />
          <Button variant="primary" onClick={create} disabled={!newId.trim()}>
            <FilePlus2 /> New
          </Button>
          <Button variant="ghost" onClick={() => importRef.current?.click()}>
            <Upload /> Import
          </Button>
          <input data-testid="workflow-list-file"
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importPackage(file);
            }}
          />
        </div>
      </header>

      {loading ? (
        <p className="empty">Loading workflows…</p>
      ) : filtered.length === 0 ? (
        <p className="empty">
          {workflows.length === 0
            ? 'No workflows yet. Name one above to start building.'
            : 'No workflows match that search.'}
        </p>
      ) : (
        <table className="workflows-table">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Triggers</th>
              <th>Size</th>
              <th>Last run</th>
              <th>Updated</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((workflow) => (
              <tr
                key={workflow.id}
                className={workflow.id === currentId ? 'current' : ''}
              >
                <td>
                  <button data-testid={`workflow-list-open-in-designer-${workflow.id}`}
                    className="workflow-name"
                    onClick={() => onOpen(workflow.id)}
                    title="Open in designer"
                  >
                    {workflow.name}
                  </button>
                  <small className="workflow-row-id">{workflow.id}</small>
                  {workflow.purpose && (
                    <small className="workflow-row-description">
                      {workflow.purpose}
                    </small>
                  )}
                  {!workflow.purpose && workflow.description && (
                    <small className="workflow-row-description">
                      {workflow.description}
                    </small>
                  )}
                  {(workflow.tags?.length ?? 0) > 0 && (
                    <span className="trigger-chips">
                      {workflow.tags!.map((tag) => (
                        <small key={tag} className="chip">
                          {tag}
                        </small>
                      ))}
                    </span>
                  )}
                  {workflow.callable && (
                    <span className="trigger-chips">
                      <small className="chip" title="Callable via parent trigger">
                        reusable
                      </small>
                    </span>
                  )}
                </td>
                <td>
                  <span className="trigger-chips">
                    {workflow.triggers.length === 0 && <small>none</small>}
                    {workflow.triggers.map((trigger) => (
                      <small
                        key={trigger.id}
                        className={trigger.enabled ? 'chip' : 'chip disabled'}
                        title={
                          trigger.enabled
                            ? `${trigger.id} (enabled)`
                            : `${trigger.id} (disabled)`
                        }
                      >
                        {trigger.kind}
                      </small>
                    ))}
                  </span>
                </td>
                <td className="numeric">
                  {workflow.pipelines} pl · {workflow.pipes} pipes
                </td>
                <td>
                  {workflow.lastRun ? (
                    <span className={`run-status ${workflow.lastRun.status}`}>
                      {workflow.lastRun.status}
                      <small>{relativeTime(workflow.lastRun.startedAt)}</small>
                    </span>
                  ) : (
                    <small>never</small>
                  )}
                </td>
                <td>
                  <small>{relativeTime(workflow.updatedAt)}</small>
                </td>
                <td className="workflow-row-actions">
                  <Button
                    size="icon"
                    aria-label={`Open ${workflow.id}`}
                    title="Open in designer"
                    onClick={() => onOpen(workflow.id)}
                  >
                    <PlayCircle />
                  </Button>
                  <Button
                    size="icon"
                    aria-label={`Export ${workflow.id}`}
                    title="Export package"
                    onClick={() => void exportPackage(workflow)}
                  >
                    <Download />
                  </Button>
                  <Button
                    size="icon"
                    aria-label={`Duplicate ${workflow.id}`}
                    title="Duplicate"
                    onClick={() => duplicate(workflow)}
                  >
                    <Copy />
                  </Button>
                  <Button
                    size="icon"
                    aria-label={`Delete ${workflow.id}`}
                    title="Delete"
                    onClick={() => remove(workflow)}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
