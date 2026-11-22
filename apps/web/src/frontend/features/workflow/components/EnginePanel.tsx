/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engine control plane: whether the in-process engine takes new runs, how
 * many at once, and where run events are copied.
 */
import React, { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { EngineState, OverlapPolicy, WorkflowEngineConfig } from '@foxschema/shared';
import { useAuthStore } from '@/platform/authStore';
import { sectionLabelCls } from '@/shared/components/surfaces';
import {
  fetchWorkflowEngineHealth,
  fetchWorkflowSettings,
  saveWorkflowSettings,
  toAdminConfigPut,
} from '../api/workflowApi';
import { toast } from '../lib/notify';

type Health = Awaited<ReturnType<typeof fetchWorkflowEngineHealth>>;

const FIELD_CLS =
  'rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 outline-none accent-focus';

const SINK_LABEL: Record<string, string> = {
  events: 'Event store (DB)',
  json: 'JSON files',
  text: 'Text files',
};

export function EnginePanel(): React.ReactElement {
  const canAdmin = useAuthStore((s) => s.can('workflow.admin'));
  const [config, setConfig] = useState<WorkflowEngineConfig | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await fetchWorkflowSettings();
        if (!cancelled) setConfig(loaded);
      } catch (err) {
        if (!cancelled) toast.error('Could not load engine settings', { description: (err as Error).message });
      }
      try {
        const next = await fetchWorkflowEngineHealth();
        if (!cancelled) setHealth(next);
      } catch (err) {
        if (!cancelled) {
          setHealth({
            ok: false,
            acceptsRuns: false,
            error: err instanceof Error ? err.message : 'health request failed',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      setConfig(await saveWorkflowSettings(toAdminConfigPut(config)));
      try {
        setHealth(await fetchWorkflowEngineHealth());
      } catch {
        /* settings saved; health chip can stay stale until the next open */
      }
    } catch (err) {
      toast.error('Save failed', { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return (
      <div className="p-4 text-xs text-slate-500" data-testid="workflow-engine">
        Loading engine settings…
      </div>
    );
  }

  const patch = (next: Partial<WorkflowEngineConfig>) => setConfig({ ...config, ...next });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" data-testid="workflow-engine">
      <section className="rounded-md border border-slate-800 bg-slate-950/60 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Settings2 className="h-4 w-4 text-slate-400" />
          Engine control plane
        </div>
        <p className="mb-3 text-[11px] text-slate-400">
          The engine runs in this FoxSchema process. Enable it to take new runs; draining finishes
          work already admitted and takes nothing new.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span
            data-testid="workflow-engine-health"
            className={`rounded border px-2 py-0.5 font-mono ${
              health?.ok
                ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'
                : 'border-rose-500/40 bg-rose-950/40 text-rose-200'
            }`}
          >
            {health
              ? health.ok
                ? `engine ready${health.acceptsRuns ? '' : ' · not taking runs'}`
                : `engine down · ${health.error ?? 'not started'}`
              : 'engine status unknown'}
          </span>
          <button
            type="button"
            data-testid="workflow-engine-save"
            disabled={saving || !canAdmin}
            title={canAdmin ? undefined : 'Changing engine settings needs the workflow admin permission'}
            onClick={() => void save()}
            className="rounded border border-cyan-500/40 bg-cyan-950/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cyan-100 hover:bg-cyan-900/50 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Engine state">
          {(
            [
              ['enabled', 'Enabled'],
              ['draining', 'Draining'],
              ['disabled', 'Disabled'],
            ] as const satisfies ReadonlyArray<readonly [EngineState, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-testid={`workflow-engine-${id}`}
              aria-pressed={config.state === id}
              onClick={() => patch({ state: id })}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition ${
                config.state === id
                  ? 'border-cyan-500/50 bg-cyan-950/50 text-cyan-100'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-4">
          <label className="flex max-w-xs flex-col gap-1">
            <span className={sectionLabelCls}>Max parallel runs</span>
            <input
              type="number"
              min={1}
              max={64}
              data-testid="workflow-engine-max-parallel"
              value={config.maxParallel}
              onChange={(e) => patch({ maxParallel: Math.min(64, Math.max(1, Number(e.target.value) || 1)) })}
              className={FIELD_CLS}
            />
          </label>
          <label className="flex max-w-xs flex-col gap-1">
            <span className={sectionLabelCls}>onOverlap</span>
            <select
              data-testid="workflow-engine-overlap"
              value={config.onOverlap}
              onChange={(e) => patch({ onOverlap: e.target.value as OverlapPolicy })}
              className={FIELD_CLS}
            >
              <option value="skip">skip</option>
              <option value="queue">queue</option>
              <option value="parallel">parallel</option>
            </select>
          </label>
        </div>
      </section>

      <section className="rounded-md border border-slate-800 bg-slate-950/60 p-4">
        <div className="mb-1 text-sm font-semibold text-slate-100">Run event sinks</div>
        <p className="mb-3 text-[11px] text-slate-500">
          Where run events are written besides the engine&apos;s own event store.
        </p>
        <ul className="space-y-2">
          {config.sinks.map((sink, idx) => (
            <li
              key={sink.kind}
              className="flex flex-wrap items-center gap-3 rounded border border-slate-800 bg-slate-900/50 px-3 py-2"
            >
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <input
                  type="checkbox"
                  data-testid={`workflow-sink-${sink.kind}`}
                  checked={sink.enabled}
                  onChange={(e) =>
                    patch({ sinks: config.sinks.map((s, i) => (i === idx ? { ...s, enabled: e.target.checked } : s)) })
                  }
                />
                {SINK_LABEL[sink.kind] ?? sink.kind}
              </label>
              <input data-testid={`workflow-engine-target-${sink.kind}`}
                value={sink.target ?? ''}
                placeholder="target"
                onChange={(e) =>
                  patch({ sinks: config.sinks.map((s, i) => (i === idx ? { ...s, target: e.target.value } : s)) })
                }
                className="min-w-[16rem] flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-300 outline-none accent-focus"
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
