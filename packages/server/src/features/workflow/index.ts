/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The workflow feature: engine settings, the engine proxy, connection grants, and
 * the token-guarded internal routes the engine calls.
 */
import { WORKFLOW_INTERNAL_PREFIX } from '@foxschema/workflow-contract';
import type { ServerFeatureModule } from '../../app/feature-module';
import { createWorkflowRoutes } from './workflow.routes';
import { createWorkflowInternalRoutes } from './workflow-internal.routes';

export const workflowFeature: ServerFeatureModule = {
  id: 'workflow',
  mounts: [
    // Called by the engine, never a browser: the shared service token, no session.
    { prefix: WORKFLOW_INTERNAL_PREFIX, access: 'internal', routes: () => createWorkflowInternalRoutes() },
    { prefix: '/api/workflow', access: 'user', routes: () => createWorkflowRoutes() },
  ],
};
