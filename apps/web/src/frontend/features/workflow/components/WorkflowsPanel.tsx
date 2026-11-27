/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow designer — ported from FoxAgent (components/WorkflowsPanel.tsx).
 */
import { Copy, Download, FilePlus2, Play, PlayCircle, ScrollText, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '@/platform/authStore';
import { toast } from '../lib/notify';
import { api, type WorkflowPackage, type WorkflowSummary } from '../api/engineClient';
import { useWorkflows } from '../api/engineQueries';
import {
  WORKFLOW_SAMPLES,
  sampleForCanvas,
  samplesAlreadyInstalled,
  saveSampleWorkflows,
} from '../lib/workflowSamples';
import { Button, Input } from './controls';

interface Props {
  /** Currently open workflow, highlighted in the list. */
  currentId: string;
  /** Load a workflow into the designer canvas. */
  onOpen: (id: string) => void;
  /** Open a workflow's log: its runs, failures and what to check. */
  onLogs: (id: string) => void;
  /** Start a blank workflow under a new id. */
  onCreate: (id: string) => void;
  /**
   * Open a sample on the canvas without waiting for a round-trip. Used when
   * the engine is unreachable so the starter is still visible.
   */
  onApplySample: (document: (typeof WORKFLOW_SAMPLES)[number]['document']) => void;
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

type WorkflowCategoryFilter = 'all' | 'dba' | 'samples' | 'scheduled';

const DBA_TAGS = new Set(['dba', 'sql', 'cdc', 'postgres', 'sqlite', 'upsert', 'audit', 'maintenance', 'retention', 'quality']);

function matchesWorkflowFilter(workflow: WorkflowSummary, category: WorkflowCategoryFilter): boolean {
  if (category === 'all') return true;
  const tags = (workflow.tags ?? []).map((t) => t.toLowerCase());
  if (category === 'samples') return workflow.id.startsWith('sample-') || tags.includes('sample');
  if (category === 'scheduled') {
    return workflow.triggers.some((t) => t.kind === 'cron' || t.kind === 'webhook');
  }
  return (
    tags.some((t) => DBA_TAGS.has(t)) ||
    /\b(dba|sql|postgres|sqlite)\b/i.test(`${workflow.id} ${workflow.name}`)
  );
}

/** Workflow browser: open, duplicate, delete, and create. */
export function WorkflowsPanel({
  currentId,
  onOpen,
  onLogs,
  onCreate,
  onApplySample,
}: Props) {
  const { workflows, loading, refresh } = useWorkflows();
  const canDesign = useAuthStore((s) => s.can('workflow.design'));
  const canRun = useAuthStore((s) => s.can('workflow.run'));
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<WorkflowCategoryFilter>('all');
  const [runningId, setRunningId] = useState<string | null>(null);
  const [newId, setNewId] = useState('');
  const [pendingDelete, setPendingDelete] = useState<WorkflowSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ pkg: WorkflowPackage; workflowId: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return workflows.filter((workflow) => {
      if (!matchesWorkflowFilter(workflow, categoryFilter)) return false;
      if (!needle) return true;
      return (
        workflow.id.toLowerCase().includes(needle) ||
        workflow.name.toLowerCase().includes(needle) ||
        (workflow.description ?? '').toLowerCase().includes(needle) ||
        (workflow.purpose ?? '').toLowerCase().includes(needle) ||
        (workflow.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [workflows, categoryFilter, query]);

  const runNow = async (workflow: WorkflowSummary) => {
    setRunningId(workflow.id);
    try {
      const res = await api.run(workflow.id, { debug: true });
      if (res.accepted === false || !res.runId) {
        toast.error('Run not started', { description: res.detail ?? res.reason ?? 'The engine declined this run.' });
        return;
      }
      refresh();
      toast.success(`Started "${workflow.name}"`, {
        description: `Debug run ${res.runId.slice(0, 8)} — open Logs to inspect output.`,
      });
    } catch (error) {
      toast.error('Run failed', { description: (error as Error).message });
    } finally {
      setRunningId(null);
    }
  };

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

  const hasSamples = samplesAlreadyInstalled(workflows.map((workflow) => workflow.id));

  const installSamples = async () => {
    const showcase = sampleForCanvas();
    try {
      await saveSampleWorkflows(api.save);
      refresh();
      onOpen(showcase.id);
      toast.success(
        hasSamples
          ? `Updated ${WORKFLOW_SAMPLES.length} sample workflows`
          : `Added ${WORKFLOW_SAMPLES.length} sample workflows`,
        {
          description: 'Open one and press Test run once the engine is Enabled.',
        },
      );
    } catch (error) {
      onApplySample(showcase.document);
      toast.error('Could not save the sample to the engine', {
        description: `${(error as Error).message} It is on the canvas — Save when the engine is reachable.`,
      });
    }
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

  const remove = (workflow: WorkflowSummary) => {
    setPendingDelete(workflow);
  };

  const confirmRemove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteWorkflow(pendingDelete.id);
      refresh();
      toast.success(`Deleted "${pendingDelete.id}"`, {
        description: 'Run history is kept — runs carry their own snapshot.',
      });
      setPendingDelete(null);
    } catch (error) {
      // The API refuses while a run is active; surface that verbatim.
      toast.error('Delete failed', { description: (error as Error).message });
    } finally {
      setDeleting(false);
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
      const defaultId =
        pkg.workflow &&
        typeof pkg.workflow === 'object' &&
        'id' in pkg.workflow &&
        typeof (pkg.workflow as { id: unknown }).id === 'string'
          ? (pkg.workflow as { id: string }).id
          : '';
      setPendingImport({ pkg, workflowId: defaultId });
    } catch (error) {
      toast.error('Import failed', { description: (error as Error).message });
    }
  };

  const confirmImport = async () => {
    if (!pendingImport) return;
    setImporting(true);
    try {
      const override = pendingImport.workflowId.trim();
      await api.importWorkflow({
        package: pendingImport.pkg,
        ...(override ? { workflowId: override } : {}),
      });
      refresh();
      toast.success('Imported workflow package');
      setPendingImport(null);
    } catch (error) {
      toast.error('Import failed', { description: (error as Error).message });
    } finally {
      setImporting(false);
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
            disabled={!canDesign}
            placeholder="new-workflow-id"
            onChange={(event) => setNewId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canDesign) create();
            }}
          />
          <Button
            variant="primary"
            onClick={create}
            disabled={!canDesign || !newId.trim()}
            title={canDesign ? undefined : 'Creating a workflow needs the workflow design permission'}
          >
            <FilePlus2 /> New
          </Button>
          <Button
            data-testid="workflow-add-sample"
            variant="ghost"
            disabled={!canDesign}
            onClick={() => void installSamples()}
            title={
              canDesign
                ? 'Install built-in sample workflows you can Test run without a database'
                : 'Installing samples needs the workflow design permission'
            }
          >
            <Sparkles /> {hasSamples ? 'Refresh samples' : 'Add samples'}
          </Button>
          <Button
            variant="ghost"
            disabled={!canDesign}
            title={canDesign ? undefined : 'Importing workflows needs the workflow design permission'}
            onClick={() => importRef.current?.click()}
          >
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

      {workflows.length > 0 && (
        <div className="workflows-filter-bar" role="group" aria-label="Filter workflows by category">
          {(
            [
              ['all', 'All'],
              ['dba', 'DBA & SQL'],
              ['samples', 'Samples'],
              ['scheduled', 'Scheduled / Webhook'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              data-testid={`workflow-list-filter-${key}`}
              className={`workflows-filter-chip${categoryFilter === key ? ' active' : ''}`}
              onClick={() => setCategoryFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="empty">Loading workflows…</p>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <p>
            {workflows.length === 0
              ? 'No workflows yet. Name one above to start building, or add the built-in samples.'
              : 'No workflows match that search.'}
          </p>
          {workflows.length === 0 && (
            <div className="mt-3 flex justify-center">
              <Button
                data-testid="workflow-empty-add-samples"
                variant="primary"
                disabled={!canDesign}
                onClick={() => void installSamples()}
              >
                <Sparkles /> Add built-in samples
              </Button>
            </div>
          )}
        </div>
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
                    <button
                      type="button"
                      data-testid={`workflow-list-last-run-${workflow.id}`}
                      className={`run-status ${workflow.lastRun.status}`}
                      title="Open this workflow's log"
                      onClick={() => onLogs(workflow.id)}
                    >
                      {workflow.lastRun.status}
                      <small>{relativeTime(workflow.lastRun.startedAt)}</small>
                    </button>
                  ) : (
                    <small>never</small>
                  )}
                </td>
                <td>
                  <small>{relativeTime(workflow.updatedAt)}</small>
                </td>
                <td className="workflow-row-actions">
                  {workflow.triggers.some((trigger) => trigger.kind === 'manual' && trigger.enabled) && (
                    <Button
                      size="icon"
                      data-testid={`workflow-list-run-${workflow.id}`}
                      disabled={!canRun || runningId === workflow.id}
                      aria-label={`Run ${workflow.id}`}
                      title={canRun ? 'Run now (debug capture enabled)' : 'Running needs the workflow run permission'}
                      onClick={() => void runNow(workflow)}
                    >
                      <Play />
                    </Button>
                  )}
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
                    data-testid={`workflow-list-logs-${workflow.id}`}
                    aria-label={`Log of ${workflow.id}`}
                    title="Log: runs, failures and what to check"
                    onClick={() => onLogs(workflow.id)}
                  >
                    <ScrollText />
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
                    disabled={!canDesign}
                    aria-label={`Duplicate ${workflow.id}`}
                    title={canDesign ? 'Duplicate' : 'Duplicating needs the workflow design permission'}
                    onClick={() => duplicate(workflow)}
                  >
                    <Copy />
                  </Button>
                  <Button
                    size="icon"
                    data-testid={`workflow-list-delete-${workflow.id}`}
                    disabled={!canDesign}
                    aria-label={`Delete ${workflow.id}`}
                    title={canDesign ? 'Delete' : 'Deleting needs the workflow design permission'}
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

      {pendingDelete &&
        createPortal(
          <div
            data-testid="workflow-delete-modal"
            className="fixed inset-0 z-[400] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
            onClick={() => !deleting && setPendingDelete(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="workflow-delete-title"
              className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/50 px-5 py-3.5">
                <h2 id="workflow-delete-title" className="text-sm font-bold text-slate-100">
                  Delete workflow?
                </h2>
                <button
                  type="button"
                  data-testid="workflow-delete-close"
                  aria-label="Close"
                  disabled={deleting}
                  onClick={() => setPendingDelete(null)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-5 space-y-3 text-xs text-slate-300">
                <p>
                  Remove <strong className="text-slate-100">{pendingDelete.name}</strong> (
                  <code className="font-mono text-slate-200">{pendingDelete.id}</code>) and its
                  workflow-scoped variables?
                </p>
                <p className="text-slate-400">
                  Past run history is preserved — each run keeps its own snapshot.
                </p>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-800 bg-slate-950/40 px-5 py-3">
                <button
                  type="button"
                  data-testid="workflow-delete-cancel"
                  disabled={deleting}
                  onClick={() => setPendingDelete(null)}
                  className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-slate-100 cursor-pointer transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="workflow-delete-confirm"
                  disabled={deleting}
                  onClick={() => void confirmRemove()}
                  className="rounded-md border border-rose-500/40 bg-rose-600/90 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-rose-500 disabled:opacity-50 cursor-pointer transition"
                >
                  {deleting ? 'Deleting…' : 'Delete workflow'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {pendingImport &&
        createPortal(
          <div
            data-testid="workflow-import-modal"
            className="fixed inset-0 z-[400] flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
            onClick={() => !importing && setPendingImport(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="workflow-import-title"
              className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/50 px-5 py-3.5">
                <h2 id="workflow-import-title" className="text-sm font-bold text-slate-100">
                  Import workflow package
                </h2>
                <button
                  type="button"
                  data-testid="workflow-import-close"
                  aria-label="Close"
                  disabled={importing}
                  onClick={() => setPendingImport(null)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-5 space-y-2.5 text-xs text-slate-300">
                <label htmlFor="workflow-import-id" className="block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Workflow ID
                </label>
                <input
                  id="workflow-import-id"
                  data-testid="workflow-import-id"
                  type="text"
                  autoFocus
                  value={pendingImport.workflowId}
                  onChange={(e) =>
                    setPendingImport((cur) => (cur ? { ...cur, workflowId: e.target.value } : null))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !importing) void confirmImport();
                  }}
                  placeholder="Leave blank to keep the package ID"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none accent-focus"
                />
                <p className="text-[11px] text-slate-400">
                  Keep the package ID or enter a new ID to avoid overwriting an existing workflow.
                </p>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-800 bg-slate-950/40 px-5 py-3">
                <button
                  type="button"
                  data-testid="workflow-import-cancel"
                  disabled={importing}
                  onClick={() => setPendingImport(null)}
                  className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-slate-100 cursor-pointer transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="workflow-import-confirm"
                  disabled={importing}
                  onClick={() => void confirmImport()}
                  className="rounded-md accent-grad on-accent-fg px-3.5 py-1.5 text-xs font-bold hover:brightness-110 disabled:opacity-50 cursor-pointer transition"
                >
                  {importing ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
