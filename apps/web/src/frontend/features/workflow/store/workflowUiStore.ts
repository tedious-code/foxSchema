/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which Workflow pane is open, the workflow being designed, and the workflow
 * whose log is open.
 */
import { create } from 'zustand';

export type WorkflowPane = 'designer' | 'workflows' | 'runs' | 'variables' | 'credentials' | 'engine' | 'logs';

/**
 * Panes reached from another pane rather than the menu. The menu highlights,
 * and the permission check uses, the pane they belong to.
 */
export const PANE_PARENT: Partial<Record<WorkflowPane, WorkflowPane>> = { logs: 'workflows' };

interface WorkflowUiState {
  view: WorkflowPane;
  busy: boolean;
  workflowId: string;
  /** The workflow the Logs pane shows. */
  logsWorkflowId: string | null;
  setView: (view: WorkflowPane) => void;
  /** Open one workflow's log. */
  openLogs: (workflowId: string) => void;
  setBusy: (busy: boolean) => void;
  setWorkflowId: (id: string) => void;
}

export const useWorkflowUiStore = create<WorkflowUiState>((set) => ({
  view: 'designer',
  busy: false,
  workflowId: 'my-workflow',
  logsWorkflowId: null,
  setView: (view) => set({ view }),
  openLogs: (logsWorkflowId) => set({ view: 'logs', logsWorkflowId }),
  setBusy: (busy) => set({ busy }),
  setWorkflowId: (workflowId) => set({ workflowId }),
}));
