/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Routes only the workflow engine calls. They sit outside the user session:
 * the engine runs on a schedule with nobody signed in, so it authenticates
 * with the service token both processes share instead.
 */
import type { FastifyReply } from 'fastify';
import {
  WORKFLOW_CONNECTION_RESOLVE_PATH,
  WORKFLOW_ENGINE_CONFIG_PATH,
  WORKFLOW_INTERNAL_PREFIX,
  type EngineRuntimeConfig,
} from '@foxschema/workflow-contract';
import { Router } from '../../platform/http/router';
import { sendError } from '../../platform/http/respond';
import type { AppRequest } from '../../platform/http/types';
import { WorkflowConnectionGrants } from './workflow-connection-grants.service';
import { WorkflowSettingsService } from './workflow-settings.service';

export function createWorkflowInternalRoutes(
  grants: Pick<WorkflowConnectionGrants, 'resolveForEngine'> = new WorkflowConnectionGrants(),
  settings: Pick<WorkflowSettingsService, 'getConfig'> = new WorkflowSettingsService(),
): Router {
  // The service token is checked for the whole mount (`access: 'internal'`),
  // by the feature registry: no route here can be reached without it.
  const router = Router();

  // The settings the engine applies itself. The endpoint is left out: it is
  // where FoxSchema finds the engine, which the engine has no use for.
  router.get(
    WORKFLOW_ENGINE_CONFIG_PATH.slice(WORKFLOW_INTERNAL_PREFIX.length),
    async (_req: AppRequest, res: FastifyReply) => {
      const { state, maxParallel, sinks } = await settings.getConfig();
      const config: EngineRuntimeConfig = { state, maxParallel, sinks };
      void res.header('cache-control', 'no-store');
      res.send(config);
    },
  );

  router.post(
    WORKFLOW_CONNECTION_RESOLVE_PATH.slice(WORKFLOW_INTERNAL_PREFIX.length),
    async (req: AppRequest, res: FastifyReply) => {
      const connectionId = (req.body as { connectionId?: unknown } | undefined)?.connectionId;
      if (typeof connectionId !== 'string' || !connectionId) {
        sendError(res, 'invalid_input', 'connectionId is required');
        return;
      }
      const resolved = await grants.resolveForEngine(connectionId);
      if (!resolved) {
        // One answer for "no such connection" and "not granted": the engine has
        // no business telling the two apart.
        sendError(res, 'not_found', 'This connection is not granted to workflows');
        return;
      }
      void res.header('cache-control', 'no-store');
      res.send(resolved);
    },
  );

  return router;
}
