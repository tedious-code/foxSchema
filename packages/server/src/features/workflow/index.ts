/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The workflow feature: engine settings, connection grants, and the in-process engine.
 */
import type { ServerFeatureModule } from '../../platform/feature-module';
import { getLogger } from '../../platform/logger/logger';
import { createWorkflowRoutes } from './workflow.routes';
import {
  startProductionWorkflowEngine,
  stopProductionWorkflowEngine,
} from './runtime/engine-host';
import { registerWorkflowEngine } from './runtime/register-engine';

export const workflowFeature: ServerFeatureModule = {
  id: 'workflow',
  mounts: [{ prefix: '/api/workflow', access: 'user', routes: () => createWorkflowRoutes() }],
  async registerFastify(app, context) {
    if (!process.env.FOXFLOW_ENCRYPTION_KEY?.trim()) {
      getLogger().warn(
        { component: 'workflow' },
        'FOXFLOW_ENCRYPTION_KEY is not set; the in-process workflow engine is not started',
      );
      return;
    }
    try {
      const { ctx, settings, grants } = await startProductionWorkflowEngine();
      await registerWorkflowEngine(app, {
        ctx,
        featureContext: context,
        settings,
        grants,
        startLifecycle: true,
      });
    } catch (err: unknown) {
      getLogger().warn(
        { component: 'workflow', err },
        'in-process workflow engine is not started',
      );
      await stopProductionWorkflowEngine().catch(() => undefined);
    }
  },
};

/** For the system feature's service status: the engine's state and health. */
export { WorkflowSettingsService } from './workflow-settings.service';
