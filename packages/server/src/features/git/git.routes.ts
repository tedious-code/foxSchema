/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Git repositories for migrations — mounted at /api/git behind the session
 * guard.
 *
 *   git.view        list repositories, branches, log; fetch
 *   git.manage      add / edit / remove repositories
 *   schema.migrate  create branches, pull, push (they change what is shared)
 */
import type { FastifyReply } from 'fastify';
import { Router } from '../../platform/http/router';
import type { AuthedRequest } from '../auth/auth.routes';
import { requirePermissions } from '../authorization/rbac.guard';
import { sendError } from '../../platform/http/respond';
import { rateLimit } from '../../platform/guards/rate-limit';
import { getStore } from '../../database/store';
import { type GitRepoInput } from './git-repos.store';
import { GitOperationError, gitErrorMessage, type GitAuthor } from './git-repo.service';
import { gitServices, type CommitInput, type PlanInput } from './git-migrations.service';
import { targetKey } from '../../platform/guards/target-lock';
import type { ConnectionRef } from '../../platform/db/resolve';
import type { ConnectionOptions } from '@foxschema/sql';

/** Resolves a saved or inline connection for the current user (the app's resolver). */
export type ResolveRef = (
  userId: string | undefined,
  ref: ConnectionRef
) => Promise<{ dialect: string; option: ConnectionOptions; schema: string }>;

/** The signed-in person as a Git author. */
async function authorOf(req: AuthedRequest): Promise<GitAuthor> {
  const store = await getStore();
  const row = await store.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [req.userId ?? '']);
  const email = row?.email ?? 'fox@localhost';
  return { name: email.split('@')[0] || 'Fox', email };
}

export function createGitRoutes(resolveRef?: ResolveRef, services = gitServices()): Router {
  const { repos: store, git: service, migrations } = services;
  const router = Router();
  const view = requirePermissions('git.view');
  const manage = requirePermissions('git.manage');
  const migrate = requirePermissions('git.view', 'schema.migrate');
  // Network operations reach a remote host: bounded per person.
  const network = rateLimit({ name: 'git-network', windowMs: 60 * 1000, max: 30 });

  const fail = (res: FastifyReply, error: unknown) => {
    const message = error instanceof GitOperationError || error instanceof Error ? error.message : gitErrorMessage(error);
    sendError(res, message === 'Repository not found.' ? 'not_found' : 'invalid_input', message);
  };

  router.get('/repos', view, async (_req: AuthedRequest, res: FastifyReply) => {
    res.send({ repos: await store.list() });
  });

  router.post('/repos', manage, async (req: AuthedRequest, res: FastifyReply) => {
    try {
      const repo = await store.create((req.body ?? {}) as GitRepoInput, req.userId ?? '', service.allowsInsecureHttp);
      res.send({ repo });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put('/repos/:id', manage, async (req: AuthedRequest, res: FastifyReply) => {
    try {
      const repo = await store.update(String(req.params.id), (req.body ?? {}) as GitRepoInput, service.allowsInsecureHttp);
      if (!repo) {
        sendError(res, 'not_found', 'Repository not found.');
        return;
      }
      res.send({ repo });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/repos/:id', manage, async (req: AuthedRequest, res: FastifyReply) => {
    const id = String(req.params.id);
    if (!(await store.remove(id))) {
      sendError(res, 'not_found', 'Repository not found.');
      return;
    }
    await service.removeLocal(id);
    res.send({ ok: true });
  });

  router.get('/repos/:id/branches', view, async (req: AuthedRequest, res: FastifyReply) => {
    try {
      res.send({ branches: await service.branches(String(req.params.id)) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/repos/:id/fetch', view, network, async (req: AuthedRequest, res: FastifyReply) => {
    try {
      res.send({ branches: await service.fetch(String(req.params.id)) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/repos/:id/branches', migrate, async (req: AuthedRequest, res: FastifyReply) => {
    const { name, from } = (req.body ?? {}) as { name?: string; from?: string };
    try {
      res.send({ branches: await service.createBranch(String(req.params.id), name ?? '', from || undefined) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/repos/:id/pull', migrate, network, async (req: AuthedRequest, res: FastifyReply) => {
    const { branch } = (req.body ?? {}) as { branch?: string };
    try {
      res.send(await service.pull(String(req.params.id), branch ?? '', await authorOf(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/repos/:id/push', migrate, network, async (req: AuthedRequest, res: FastifyReply) => {
    const { branch } = (req.body ?? {}) as { branch?: string };
    try {
      res.send(await service.push(String(req.params.id), branch ?? ''));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/repos/:id/log', view, async (req: AuthedRequest, res: FastifyReply) => {
    const branch = typeof req.query.branch === 'string' ? req.query.branch : '';
    const limit = Number(req.query.limit) || 50;
    try {
      res.send({ commits: await service.log(String(req.params.id), branch, limit) });
    } catch (error) {
      fail(res, error);
    }
  });

  /** The file a commit would add, for review before committing. */
  router.post('/repos/:id/preview', view, async (req: AuthedRequest, res: FastifyReply) => {
    try {
      res.send(await migrations.preview(String(req.params.id), (req.body ?? {}) as PlanInput, await authorOf(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  /** Commit a migration plan to a branch (and push when asked). */
  router.post('/repos/:id/commit', migrate, async (req: AuthedRequest, res: FastifyReply) => {
    try {
      res.send(await migrations.commit(String(req.params.id), (req.body ?? {}) as CommitInput, await authorOf(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Migration files on a branch; with a connection in the body, which have
   * been applied to that database and which are incoming.
   */
  router.post('/repos/:id/migrations', view, async (req: AuthedRequest, res: FastifyReply) => {
    const { branch, ...ref } = (req.body ?? {}) as { branch?: string } & ConnectionRef;
    try {
      let target: { key: string; dialect: string } | undefined;
      const hasRef = Object.keys(ref).length > 0;
      if (hasRef) {
        if (!resolveRef) throw new GitOperationError('Choosing a database is not available here.');
        const r = await resolveRef(req.userId, ref);
        target = { key: targetKey({ dialect: r.dialect, host: r.option.host, database: r.option.database, schema: r.schema }), dialect: r.dialect };
      }
      res.send(await migrations.list(String(req.params.id), branch ?? '', target));
    } catch (error) {
      fail(res, error);
    }
  });

  /** One committed migration: header, steps and the file itself. */
  router.get('/repos/:id/file', view, async (req: AuthedRequest, res: FastifyReply) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      res.send(await migrations.read(String(req.params.id), ref, path));
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
