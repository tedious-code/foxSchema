/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow workspace: the designer and the engine panes behind one tab strip.
 * Tab visibility follows the same RBAC keys the engine proxy enforces, so a
 * viewer who can open Workflow does not see Design / Variables / Engine chrome
 * that would only 403.
 */
import React, { useEffect, useMemo } from 'react';
import { Activity, Braces, KeyRound, ListTree, Power, Workflow } from 'lucide-react';
import type { Permission } from '@foxschema/shared';
import '@xyflow/react/dist/style.css';
import '../workflow.css';
import { useAuthStore } from '@/platform/authStore';
import { useWorkflowUiStore, type WorkflowPane } from '../store/workflowUiStore';
import { WorkflowDesigner } from './WorkflowDesigner';

const PANES: {
  id: WorkflowPane;
  label: string;
  icon: React.ElementType;
  /** Open the pane. Mutating actions inside still check their own keys. */
  permission: Permission;
}[] = [
  { id: 'designer', label: 'Designer', icon: Workflow, permission: 'workflow.design' },
  // Listing workflows/runs is workflow.access on the proxy; starting a run is
  // gated separately with workflow.run inside the designer.
  { id: 'workflows', label: 'Workflows', icon: ListTree, permission: 'workflow.access' },
  { id: 'runs', label: 'Runs', icon: Activity, permission: 'workflow.access' },
  { id: 'variables', label: 'Variables', icon: Braces, permission: 'workflow.design' },
  { id: 'credentials', label: 'Credentials', icon: KeyRound, permission: 'workflow.design' },
  { id: 'engine', label: 'Engine', icon: Power, permission: 'workflow.admin' },
];

export const WorkflowView: React.FC = () => {
  const pane = useWorkflowUiStore((s) => s.view);
  const setPane = useWorkflowUiStore((s) => s.setView);
  const can = useAuthStore((s) => s.can);

  const visiblePanes = useMemo(() => PANES.filter((p) => can(p.permission)), [can]);

  useEffect(() => {
    if (visiblePanes.length === 0) return;
    if (!visiblePanes.some((p) => p.id === pane)) {
      setPane(visiblePanes[0]!.id);
    }
  }, [pane, setPane, visiblePanes]);

  return (
    <div className="fox-workflow flex min-h-0 flex-1 flex-col" data-testid="workflow-view">
      <nav
        className="mx-3 mb-0 mt-2 flex shrink-0 flex-wrap items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/50 p-0.5"
        aria-label="Workflow"
        data-testid="workflow-menu"
      >
        <span className="px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Workflow</span>
        {visiblePanes.map((p) => {
          const active = pane === p.id;
          return (
            <button
              key={p.id}
              type="button"
              data-testid={`workflow-tab-${p.id}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => setPane(p.id)}
              className={`flex cursor-pointer items-center gap-1.5 rounded px-2.5 py-1 text-xs font-semibold transition ${
                active ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
              }`}
            >
              <p.icon className="h-3.5 w-3.5 shrink-0" />
              {p.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-slate-800">
        {visiblePanes.length === 0 ? (
          <p className="p-4 text-sm text-slate-500" data-testid="workflow-no-panes">
            No Workflow panes are available for this role.
          </p>
        ) : (
          <WorkflowDesigner />
        )}
      </div>
    </div>
  );
};
