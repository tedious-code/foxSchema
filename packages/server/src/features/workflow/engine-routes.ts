/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which in-process engine paths the designer may reach, and what it takes.
 * Anything not listed — public trigger ingress above all — is not mounted
 * behind a FoxSchema session.
 */
import type { Permission } from '@foxschema/shared';
import { linkedConnectionId } from '@foxschema/shared';

export interface EngineRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Path under `/api/workflow/engine`, in Fastify `:param` syntax. */
  path: string;
  permission: Permission;
  /** Starts engine work, so it is refused while the engine is not accepting runs. */
  startsRun?: true;
  /**
   * The workflow whose saved connections the caller must be able to use:
   * the request body, the stored workflow `:id`, both (a save must not drop a
   * connection the caller cannot use), or the snapshot of run `:id`.
   */
  connections?: 'body' | 'workflow' | 'body-and-stored' | 'run' | 'run-list';
}

/**
 * Every engine route the designer may reach, and what it takes to reach it.
 *
 * Deliberately absent — and not registered on the FoxSchema mount: public
 * trigger ingress, `/setup/credentials`, dry runs, agent propose, pipeline
 * mutate, run snapshots, and the extra variable endpoints the designer does
 * not call. Add a route here only when a screen needs it, then mount it.
 *
 * Reading follows `workflow.access`. Anything that changes a definition, or
 * touches environments and variables, is `workflow.design`. Starting and
 * steering runs is `workflow.run`. Creating or deleting an engine credential
 * stores a secret, so it is `workflow.admin`; listing them returns names and
 * kinds only, which authoring needs.
 */
export const ENGINE_ROUTES: readonly EngineRoute[] = [
  { method: 'GET', path: '/pipes', permission: 'workflow.access' },
  { method: 'GET', path: '/middleware', permission: 'workflow.access' },
  { method: 'GET', path: '/workflows', permission: 'workflow.access' },
  { method: 'GET', path: '/workflows/:id', permission: 'workflow.access', connections: 'workflow' },
  { method: 'GET', path: '/workflows/:id/export', permission: 'workflow.access', connections: 'workflow' },
  { method: 'GET', path: '/runs', permission: 'workflow.access', connections: 'run-list' },
  // A run's detail and events carry what its connections returned (debug
  // samples are rows), so they follow the same rule as running it.
  { method: 'GET', path: '/runs/:id', permission: 'workflow.access', connections: 'run' },
  { method: 'GET', path: '/runs/:id/failure', permission: 'workflow.access', connections: 'run' },
  { method: 'GET', path: '/runs/:id/events', permission: 'workflow.access', connections: 'run' },
  { method: 'GET', path: '/runs/:id/events/stream', permission: 'workflow.access', connections: 'run' },

  { method: 'POST', path: '/workflows/validate', permission: 'workflow.design' },
  { method: 'POST', path: '/workflows/import', permission: 'workflow.design', connections: 'body' },
  { method: 'PUT', path: '/workflows/:id', permission: 'workflow.design', connections: 'body-and-stored' },
  { method: 'DELETE', path: '/workflows/:id', permission: 'workflow.design', connections: 'workflow' },
  { method: 'POST', path: '/workflows/:id/duplicate', permission: 'workflow.design', connections: 'workflow' },
  { method: 'POST', path: '/workflows/:id/extract-pipeline', permission: 'workflow.design', connections: 'workflow' },
  { method: 'POST', path: '/preview/parse', permission: 'workflow.design' },
  { method: 'GET', path: '/environments', permission: 'workflow.design' },
  { method: 'POST', path: '/environments', permission: 'workflow.design' },
  { method: 'POST', path: '/environments/:id/activate', permission: 'workflow.design' },
  { method: 'DELETE', path: '/environments/:id', permission: 'workflow.design' },
  { method: 'GET', path: '/environments/:id/variables', permission: 'workflow.design' },
  { method: 'PUT', path: '/environments/:id/variables', permission: 'workflow.design' },
  { method: 'DELETE', path: '/variables/:id', permission: 'workflow.design' },
  { method: 'POST', path: '/variables/clone', permission: 'workflow.design' },
  { method: 'GET', path: '/credentials', permission: 'workflow.design' },

  { method: 'POST', path: '/credentials', permission: 'workflow.admin' },
  { method: 'DELETE', path: '/credentials/:id', permission: 'workflow.admin' },

  { method: 'POST', path: '/workflows/:id/run', permission: 'workflow.run', startsRun: true, connections: 'workflow' },
  // Steering a run that is already going. The Runs panel calls these.
  { method: 'POST', path: '/runs/:id/cancel', permission: 'workflow.run', connections: 'run' },
  { method: 'POST', path: '/runs/:id/resume', permission: 'workflow.run', connections: 'run' },
  { method: 'GET', path: '/runs/:id/inputs', permission: 'workflow.run', connections: 'run' },
  { method: 'POST', path: '/runs/:id/inputs', permission: 'workflow.run', connections: 'run' },
];

/** A request that would start a run arrived while the engine is not `enabled`. */
export const ENGINE_NOT_ACCEPTING_MESSAGE =
  'The workflow engine is not accepting new runs. A workflow admin can enable it in the control panel.';

/** The saved connections a workflow document reaches: each linked credential it names. */
export function linkedConnectionsIn(document: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const id = linkedConnectionId(value);
      if (id) found.add(id);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(document);
  return [...found];
}
