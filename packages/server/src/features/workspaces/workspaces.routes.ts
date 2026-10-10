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
import { WorkspaceInvites } from './workspace-invites.service';
import { AuthMailer } from '../auth/auth-mail';

function actorOf(req: AuthedRequest): WorkspaceActor {
  return { userId: req.userId!, appRole: req.appRole ?? 'viewer', permissions: req.permissions ?? new Set() };
}

function fail(res: FastifyReply, error: unknown): void {
  if (error instanceof ServiceError) sendError(res, error.code, error.message);
  else sendError(res, 'failed', error instanceof Error ? error.message : 'Request failed');
}

export function createWorkspaceRoutes(
  directory = new WorkspaceDirectory(),
  invites = new WorkspaceInvites(),
  mailer = new AuthMailer()
): Router {
  const router = Router();
  const id = (req: AuthedRequest) => String(req.params.id ?? '');

  // Invites waiting for the caller. Declared before /:id routes so "invites"
  // is never read as a workspace id.
  router.get('/invites', async (req: AuthedRequest, res: FastifyReply) => {
    res.send({ invites: await invites.mine(req.userId!) });
  });

  router.post('/invites/:inviteId/accept', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      res.send({ workspaceId: await invites.accept(req.userId!, String(req.params.inviteId ?? '')) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/invites/:inviteId/decline', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      await invites.decline(req.userId!, String(req.params.inviteId ?? ''));
      res.send({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

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

  router.get('/:id/invites', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      res.send({ invites: await invites.listForWorkspace(actorOf(req), id(req)) });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Invite by email. When that made the account, its one-time code is
   * emailed. Only an admin also gets the code back to pass on: anyone else
   * holding it could claim an account under someone else's address.
   */
  router.post('/:id/invites', async (req: AuthedRequest, res: FastifyReply) => {
    const body = (req.body ?? {}) as { email?: unknown; role?: unknown };
    try {
      const actor = actorOf(req);
      const { invite, newAccount } = await invites.invite(actor, id(req), body.email, body.role);
      if (!newAccount) {
        res.send({ invite });
        return;
      }
      let delivery: string;
      try {
        delivery = await mailer.send('invite', newAccount, invite.invitedBy || undefined);
      } catch {
        delivery = 'failed';
      }
      res.send({
        invite,
        newAccount:
          actor.appRole === 'admin'
            ? { code: newAccount.code, link: await mailer.link('invite', newAccount.code), expiresAt: newAccount.expiresAt, delivery }
            : { expiresAt: newAccount.expiresAt, delivery },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/:id/invites/:inviteId', async (req: AuthedRequest, res: FastifyReply) => {
    try {
      await invites.revoke(actorOf(req), id(req), String(req.params.inviteId ?? ''));
      res.send({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
