/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * /api/workspaces — the caller's workspaces, choosing one, and running one
 * (name, archive, members). Mounted behind `authGuard`.
 */
import type { FastifyReply } from 'fastify';
import { Router } from '../../platform/http/router';
import type { AuthedRequest } from '../../platform/http/types';
import { sendError } from '../../platform/http/respond';
import { ServiceError } from '../../platform/contracts/actor';
import { WorkspaceDirectory, type WorkspaceActor } from './workspace-directory.service';

function actorOf(req: AuthedRequest): WorkspaceActor {
  return { userId: req.userId!, appRole: req.appRole ?? 'viewer', permissions: req.permissions ?? new Set() };
}

function fail(res: FastifyReply, error: unknown): void {
  if (error instanceof ServiceError) sendError(res, error.code, error.message);
  else sendError(res, 'failed', error instanceof Error ? error.message : 'Request failed');
}

export function createWorkspaceRoutes(directory = new WorkspaceDirectory()): Router {
  const router = Router();
  const id = (req: AuthedRequest) => String(req.params.id ?? '');

  /** Where this session acts, everywhere it may, and whether it may make more. */
  router.get('/', async (req: AuthedRequest, res: FastifyReply) => {
    const actor = actorOf(req);
    res.send({
      currentId: req.workspaceId,
      workspaces: await directory.listMine(actor.userId),
      canCreate: await directory.canCreate(actor),
    });
  });

  router.post('/', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      res.send({ workspace: await directory.create(actorOf(req), (req.body as { name?: unknown } | undefined)?.name) });
    } catch (error) {
      fail(res, error);
    }
  });

  /** Act in this workspace from now on (every tab and the CLI's next run follow). */
  router.post('/:id/select', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      await directory.select(req.userId!, id(req));
      res.send({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/:id', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      await directory.rename(actorOf(req), id(req), (req.body as { name?: unknown } | undefined)?.name);
      res.send({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/:id/archive', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      await directory.archive(actorOf(req), id(req));
      res.send({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/:id/members', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      res.send({ members: await directory.members(actorOf(req), id(req)) });
    } catch (error) {
      fail(res, error);
    }
  });

  /** An admin adds an existing account directly; changing an existing member's role needs workspace.members. */
  router.put('/:id/members/:userId', async (req: AuthedRequest, res: FastifyReply) => {
    const role = (req.body as { role?: unknown } | undefined)?.role;
    const userId = String(req.params.userId ?? '');
    try {
      const actor = actorOf(req);
      const isMember = (await directory.members(actor, id(req)).catch(() => [])).some((m) => m.userId === userId);
      if (isMember) await directory.setMemberRole(actor, id(req), userId, role);
      else await directory.addMember(actor, id(req), userId, role);
      res.send({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/:id/members/:userId', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      await directory.removeMember(actorOf(req), id(req), String(req.params.userId ?? ''));
      res.send({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
