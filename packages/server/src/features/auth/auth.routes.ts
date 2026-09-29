/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { setCookie, clearCookie } from '../../platform/http/reply';
import type { FastifyReply } from 'fastify';
import type { AppRequest, AuthedRequest, NextFunction } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { AuthModule, SESSION_COOKIE, SESSION_MAX_AGE_MS, type AuthUser } from '../auth/auth.service';
import { sendError } from '../../platform/http/respond';
import { rateLimit } from '../../platform/guards/rate-limit';
import { getLogger } from '../../platform/logger/logger';
import { isDirectLocalRequest, resetSetupCode, setupCode, setupCodeMatches } from './setup-code';

export type { AuthedRequest };

/** Put the resolved session user's identity + grants on the request. */
export function attachAuthUser(user: AuthUser, req: AuthedRequest): void {
  req.userId = user.id;
  req.appRole = user.role;
  req.permissions = new Set(user.permissions);
}

/** Minimal cookie reader (avoids a cookie-parser dependency). */
export function readCookie(req: AppRequest, name: string): string | undefined {
  // Node types a repeated header as an array; a browser never sends Cookie
  // twice, but the type is honest and the join costs nothing.
  const raw = req.headers.cookie;
  const header = Array.isArray(raw) ? raw.join('; ') : raw;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(res: FastifyReply, token: string): void {
  setCookie(res, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

export function createAuthRoutes(auth: AuthModule): Router {
  const router = Router();

  // Sign-in is the only way in, so it is what gets guessed at. Per address,
  // before any account exists to charge.
  const signInLimiter = rateLimit({ name: 'sign-in', windowMs: 15 * 60 * 1000, max: 20 });

  // No self-registration: an admin adds accounts (POST /api/admin/users).
  router.post('/register', (_req: AppRequest, res: FastifyReply) => {
    sendError(res, 'forbidden', 'Accounts are created by an administrator. Ask yours to add you.');
  });

  /**
   * First-run setup state. Says whether setup is still open and whether this
   * caller will need the setup code, so the sign-in screen can ask for it.
   */
  router.get('/setup', async (req: AppRequest, res: FastifyReply) => {
    const state = await auth.setupState();
    const codeRequired = state.setupRequired && !isDirectLocalRequest(req);
    if (codeRequired) announceSetupCode();
    res.send({ ...state, setupCodeRequired: codeRequired });
  });

  router.post('/setup', signInLimiter, async (req: AppRequest, res: FastifyReply) => {
    const { email, password, code } = (req.body ?? {}) as { email?: string; password?: string; code?: string };
    const state = await auth.setupState();
    if (!state.setupRequired) {
      sendError(res, 'conflict', 'Setup is already complete. Sign in instead.');
      return;
    }
    if (!isDirectLocalRequest(req) && !setupCodeMatches(code)) {
      announceSetupCode();
      sendError(res, 'forbidden', 'Enter the setup code printed in the Fox server log.');
      return;
    }
    try {
      const { user, token } = await auth.completeSetup(email ?? '', password ?? '');
      resetSetupCode();
      setSessionCookie(res, token);
      res.send({ user });
    } catch (error: unknown) {
      sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Setup failed');
    }
  });

  router.post('/login', signInLimiter, async (req: AppRequest, res: FastifyReply) => {
    const { email, password } = req.body as { email: string; password: string };
    try {
      const { user, token } = await auth.login(email, password);
      setSessionCookie(res, token);
      res.send({ user });
    } catch (error: unknown) {
      sendError(res, 'unauthenticated', error instanceof Error ? error.message : 'Login failed');
    }
  });

  router.post('/logout', async (req: AppRequest, res: FastifyReply) => {
    await auth.logout(readCookie(req, SESSION_COOKIE));
    clearCookie(res, SESSION_COOKIE, { path: '/' });
    res.send({ ok: true });
  });

  router.get('/me', async (req: AppRequest, res: FastifyReply) => {
    const user = await auth.getUserByToken(readCookie(req, SESSION_COOKIE));
    if (user) {
      res.send({ user });
      return;
    }
    // Nobody signed in is an answer, not an error: the app asks this on every
    // boot, and a 401 here is logged by the browser as a failed request.
    res.send({ user: null });
  });

  return router;
}

/** Guard for protected routes — attaches userId + RBAC or 401s. */
export function authGuard(auth: AuthModule) {
  return async (req: AuthedRequest, res: FastifyReply, next: NextFunction) => {
    try {
      const user = await auth.getUserByToken(readCookie(req, SESSION_COOKIE));
      if (!user) {
        sendError(res, 'unauthenticated', 'Authentication required');
        return;
      }
      attachAuthUser(user, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

let announced = false;

/** Print the setup code to the server log, once, when someone may need it. */
function announceSetupCode(): void {
  if (announced) return;
  announced = true;
  getLogger().warn(
    `First-run setup: enter code ${setupCode()} on the sign-in screen to create the admin account ` +
      '(only needed when setting up from another machine).'
  );
}
