/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * FoxWorkflow control-plane settings, in-process engine health, and the
 * saved-connection grants the designer uses.
 */
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import {
  ENGINE_STATES,
  connectionCredentialId,
  type AdminConfigPut,
  type LogSinkKind,
  type OverlapPolicy,
} from '@foxschema/workflow-contract';
import type { CredentialStore } from '@foxschema/workflow-engine';
import { requirePermissions } from '../../platform/authorization/rbac.guard';
import { sendError } from '../../platform/http/respond';
import { WorkflowSettingsService } from './workflow-settings.service';
import { WorkflowConnectionGrants } from './workflow-connection-grants.service';
import { actorOf } from '../../platform/http/actor-of';
import { getProductionWorkflowEngine } from './runtime/engine-host';

const OVERLAP_POLICIES: readonly OverlapPolicy[] = ['skip', 'queue', 'parallel'];
const SINK_KINDS: readonly LogSinkKind[] = ['events', 'json', 'text'];

/**
 * What is wrong with a settings change, or null. Every engine applies these
 * settings and refuses the whole refresh on a value it does not know — so a
 * saved typo stopped every later change from applying.
 */
function settingsProblem(body: AdminConfigPut): string | null {
  if (body.state !== undefined && !(ENGINE_STATES as readonly unknown[]).includes(body.state)) {
    return `state must be one of: ${ENGINE_STATES.join(', ')}`;
  }
  if (body.onOverlap !== undefined && !(OVERLAP_POLICIES as readonly unknown[]).includes(body.onOverlap)) {
    return `onOverlap must be one of: ${OVERLAP_POLICIES.join(', ')}`;
  }
  if (body.sinks !== undefined) {
    if (!Array.isArray(body.sinks)) return 'sinks must be an array';
    const unknown = body.sinks.find((sink) => !(SINK_KINDS as readonly unknown[]).includes(sink?.kind));
    if (unknown !== undefined) return `each sink kind must be one of: ${SINK_KINDS.join(', ')}`;
  }
  return null;
}

type SettingsApi = Pick<WorkflowSettingsService, 'getConfig' | 'putConfig' | 'probeEngineHealth'>;
type GrantsApi = Pick<WorkflowConnectionGrants, 'list' | 'grant' | 'revoke' | 'notUsableBy'>;
type CredentialsApi = Pick<CredentialStore, 'create' | 'remove'>;

export interface WorkflowRouteDeps {
  settings?: SettingsApi;
  grants?: GrantsApi;
  credentials?: CredentialsApi;
}

export function createWorkflowRoutes(deps: WorkflowRouteDeps = {}): Router {
  const fallbackSettings = deps.settings ?? new WorkflowSettingsService();
  const fallbackGrants = deps.grants ?? new WorkflowConnectionGrants();
  const settingsOf = (): SettingsApi =>
    deps.settings ?? getProductionWorkflowEngine()?.settings ?? fallbackSettings;
  const grantsOf = (): GrantsApi =>
    deps.grants ?? getProductionWorkflowEngine()?.grants ?? fallbackGrants;
  const credentialsOf = (): CredentialsApi | undefined =>
    deps.credentials ?? getProductionWorkflowEngine()?.backend.credentials;
  const router = Router();

  // Saved connections, and which of them workflows may use. Only the owner can
  // grant one: the engine then resolves it on their behalf, per run. The
  // permission guard has already refused a caller with no user.
  router.get(
    '/connections',
    requirePermissions('workflow.design'),
    async (req: AppRequest, res: FastifyReply) => {
      res.send({ connections: await grantsOf().list(actorOf(req).scope!) });
    },
  );

  router.put(
    '/connections/:id/grant',
    requirePermissions('workflow.design'),
    async (req: AppRequest, res: FastifyReply) => {
      const { id } = req.params as { id: string };
      const name = await grantsOf().grant(actorOf(req).scope!, id);
      if (name === undefined) {
        sendError(res, 'not_found', 'Saved connection not found');
        return;
      }
      const credentials = credentialsOf();
      const credentialId = connectionCredentialId(id);
      if (!credentials) {
        await grantsOf().revoke(actorOf(req).userId!, id);
        sendError(res, 'unavailable', 'The workflow engine did not record the connection');
        return;
      }
      try {
        await credentials.create({
          id: credentialId,
          name: (name || id).slice(0, 80),
          kind: 'database',
          source: 'foxschema',
          data: { connectionId: id },
        });
      } catch {
        await grantsOf().revoke(actorOf(req).userId!, id);
        sendError(res, 'unavailable', 'The workflow engine did not record the connection');
        return;
      }
      res.send({ ok: true, credentialId });
    },
  );

  router.delete(
    '/connections/:id/grant',
    requirePermissions('workflow.design'),
    async (req: AppRequest, res: FastifyReply) => {
      const { id } = req.params as { id: string };
      if (await grantsOf().revoke(actorOf(req).userId!, id)) {
        // Best-effort: the grant is already gone even if the engine credential is not.
        await credentialsOf()
          ?.remove(connectionCredentialId(id))
          .catch(() => undefined);
      }
      res.send({ ok: true });
    },
  );

  router.get(
    '/settings',
    requirePermissions('workflow.access'),
    async (_req: AppRequest, res: FastifyReply) => {
      res.send({ config: await settingsOf().getConfig() });
    },
  );

  router.put(
    '/settings',
    requirePermissions('workflow.admin'),
    async (req: AppRequest, res: FastifyReply) => {
      const body = { ...((req.body ?? {}) as AdminConfigPut) };
      const problem = settingsProblem(body);
      if (problem) {
        sendError(res, 'invalid_input', problem);
        return;
      }
      res.send({ config: await settingsOf().putConfig(body) });
    },
  );

  router.get(
    '/engine/health',
    requirePermissions('workflow.access'),
    async (_req: AppRequest, res: FastifyReply) => {
      res.send(await settingsOf().probeEngineHealth());
    },
  );

  return router;
}
