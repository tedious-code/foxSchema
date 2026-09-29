/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Public first-open email subscriber wizard (no login required).
 * Mounted before authGuard so it still appears before sign-in.
 */
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { AppSettingsStore } from '../admin/app-settings.service';
import { SignupModule } from './signup-wizard.service';
import { rateLimit } from '../../platform/guards/rate-limit';
import { sendError } from '../../platform/http/respond';

export function createSignupRoutes(
  signupModule = new SignupModule(new AppSettingsStore())
): Router {
  const router = Router();

  // Cap per IP: legit use is one or two calls (submit / retry / skip).
  const signupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

  router.get('/state', async (_req: AppRequest, res: FastifyReply) => {
    res.send(await signupModule.getState());
  });

  router.post('/', signupLimiter, async (req: AppRequest, res: FastifyReply) => {
    const { email, source } = req.body as { email?: string; source?: string };
    if (!email) {
      sendError(res, 'invalid_input', 'Email is required.');
      return;
    }
    const src = source === 'cli' ? 'cli' : 'web';
    res.send(await signupModule.submit(email, src));
  });

  router.post('/skip', signupLimiter, async (_req: AppRequest, res: FastifyReply) => {
    await signupModule.skip();
    res.send({ ok: true });
  });

  return router;
}
