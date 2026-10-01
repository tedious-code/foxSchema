/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Admin: how people sign in. SSO providers, the email relay for reset and
 * invite codes, and the public URL. Mounted at /api/admin/sign-in behind the
 * session guard; every route needs `admin.users`.
 */
import type { FastifyReply } from 'fastify';
import { Router } from '../../platform/http/router';
import type { AuthedRequest } from './auth.routes';
import { requirePermissions } from '../authorization/rbac.guard';
import { sendError } from '../../platform/http/respond';
import { rateLimit } from '../../platform/guards/rate-limit';
import { isSsoProviderId, SignInSettings } from './sign-in-settings.service';
import { AuthMailer } from './auth-mail';
import { redirectUri } from './sso.service';

export function createSignInSettingsRoutes(settings = new SignInSettings(), mailer = new AuthMailer(settings)): Router {
  const router = Router();
  const guard = requirePermissions('admin.users');
  const testMailLimiter = rateLimit({ name: 'test-email', windowMs: 60 * 1000, max: 5 });

  const fail = (res: FastifyReply, error: unknown) =>
    sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Could not save');

  router.get('/', guard, async (req: AuthedRequest, res: FastifyReply) => {
    const summary = await settings.summary();
    // The callback URL to register with each provider.
    const providers = summary.providers.map((p) => ({ ...p, redirectUri: redirectUri(req, p.id, summary.publicUrl) }));
    res.send({ ...summary, providers });
  });

  router.put('/providers/:id', guard, async (req: AuthedRequest, res: FastifyReply) => {
    const id = String(req.params.id ?? '');
    if (!isSsoProviderId(id)) {
      sendError(res, 'not_found', 'Unknown provider.');
      return;
    }
    try {
      await settings.saveProvider(id, (req.body ?? {}) as { clientId?: string; clientSecret?: string; tenant?: string });
      res.send({ ok: true });
    } catch (error: unknown) {
      fail(res, error);
    }
  });

  router.delete('/providers/:id', guard, async (req: AuthedRequest, res: FastifyReply) => {
    const id = String(req.params.id ?? '');
    if (!isSsoProviderId(id)) {
      sendError(res, 'not_found', 'Unknown provider.');
      return;
    }
    await settings.removeProvider(id);
    res.send({ ok: true });
  });

  router.put('/mail', guard, async (req: AuthedRequest, res: FastifyReply) => {
    try {
      await settings.saveMail((req.body ?? {}) as Parameters<SignInSettings['saveMail']>[0]);
      res.send({ ok: true });
    } catch (error: unknown) {
      fail(res, error);
    }
  });

  router.delete('/mail', guard, async (_req: AuthedRequest, res: FastifyReply) => {
    await settings.removeMail();
    res.send({ ok: true });
  });

  router.post('/mail/test', guard, testMailLimiter, async (req: AuthedRequest, res: FastifyReply) => {
    const { to } = (req.body ?? {}) as { to?: unknown };
    if (typeof to !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim())) {
      sendError(res, 'invalid_input', 'Enter the address to send the test to.');
      return;
    }
    try {
      await mailer.sendTest(to.trim());
      res.send({ ok: true });
    } catch (error: unknown) {
      sendError(res, 'failed', error instanceof Error ? error.message : 'Could not send');
    }
  });

  /** Turn Google / GitHub through the Fox sign-in service on or off. */
  router.put('/broker', guard, async (req: AuthedRequest, res: FastifyReply) => {
    const { enabled } = (req.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      sendError(res, 'invalid_input', 'enabled must be true or false.');
      return;
    }
    try {
      await settings.setBroker(enabled);
      res.send({ ok: true });
    } catch (error: unknown) {
      fail(res, error);
    }
  });

  router.put('/public-url', guard, async (req: AuthedRequest, res: FastifyReply) => {
    const { url } = (req.body ?? {}) as { url?: unknown };
    try {
      await settings.savePublicUrl(typeof url === 'string' ? url : '');
      res.send({ ok: true });
    } catch (error: unknown) {
      fail(res, error);
    }
  });

  return router;
}
