/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { setCookie, clearCookie } from '../../platform/http/reply';
import type { FastifyReply } from 'fastify';
import type { AppRequest, AuthedRequest, NextFunction } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { AuthModule, SESSION_COOKIE, SESSION_MAX_AGE_MS, SignInLockedError, type AuthUser } from '../auth/auth.service';
import { AuthMailer } from './auth-mail';
import { SignupModule } from '../users/signup-wizard.service';
import { AppSettingsStore } from '../admin/app-settings.service';
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
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed escape (a stray %) reads as no cookie: signed out, not a 500.
      return undefined;
    }
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

export function createAuthRoutes(
  auth: AuthModule,
  mailer = new AuthMailer(),
  signup = new SignupModule(new AppSettingsStore())
): Router {
  const router = Router();

  /**
   * A new account's owner ticked "Email me Fox news": pass it on to the
   * subscriber list, after the reply, and never let it fail the sign-up.
   */
  const subscribeIfAsked = (wanted: unknown, email: string) => {
    if (wanted !== true) return;
    signup.subscribeNewAccount(email).catch((error: unknown) => {
      getLogger().warn(
        `Could not add a new account to the Fox news list: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  };

  // Sign-in is the only way in, so it is what gets guessed at. Per address,
  // before any account exists to charge.
  const signInLimiter = rateLimit({ name: 'sign-in', windowMs: 15 * 60 * 1000, max: 20 });
  // Asking for a reset sends email, and a code is guessed at here: fewer.
  const resetLimiter = rateLimit({ name: 'password-reset', windowMs: 15 * 60 * 1000, max: 10 });

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
    const { email, password, code, subscribe } = (req.body ?? {}) as {
      email?: string;
      password?: string;
      code?: string;
      subscribe?: unknown;
    };
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
      subscribeIfAsked(subscribe, user.email);
    } catch (error: unknown) {
      sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Setup failed');
    }
  });

  router.post('/login', signInLimiter, async (req: AppRequest, res: FastifyReply) => {
    const { email, password } = req.body as { email: string; password: string };
    try {
      const { user, token } = await auth.login(email, password, req.ip);
      setSessionCookie(res, token);
      res.send({ user });
    } catch (error: unknown) {
      if (error instanceof SignInLockedError) {
        res.header('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
        sendError(res, 'rate_limited', error.message);
        return;
      }
      sendError(res, 'unauthenticated', error instanceof Error ? error.message : 'Login failed');
    }
  });

  /**
   * Forgot password. The answer is the same whether or not the email has an
   * account, and the code is sent after the response, so neither the reply
   * nor its timing says which emails exist. `delivery` describes the install
   * (email or server log), not the account.
   */
  router.post('/password/forgot', resetLimiter, async (req: AppRequest, res: FastifyReply) => {
    const { email } = (req.body ?? {}) as { email?: string };
    const delivery = await mailer.delivery();
    res.send({ ok: true, delivery });
    try {
      const issued = await auth.requestPasswordReset(email ?? '');
      if (issued) await mailer.send('reset', issued);
    } catch (error: unknown) {
      getLogger().warn(
        `Could not send a password-reset email: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  /** Who a reset or invite code is for, so the page can greet them; 404s when it does not work. */
  router.post('/password/code', resetLimiter, async (req: AppRequest, res: FastifyReply) => {
    const { code } = (req.body ?? {}) as { code?: string };
    const found = await auth.inspectCode(code);
    if (!found) {
      sendError(res, 'not_found', 'This code is wrong or has expired. Ask for a new one.');
      return;
    }
    res.send(found);
  });

  /** Choose a password with a reset or invite code, and sign in. */
  router.post('/password/reset', resetLimiter, async (req: AppRequest, res: FastifyReply) => {
    const { code, password, subscribe } = (req.body ?? {}) as { code?: string; password?: string; subscribe?: unknown };
    try {
      const { user, token, purpose } = await auth.redeemCode(code, password ?? '');
      setSessionCookie(res, token);
      res.send({ user });
      // Only a new account (an accepted invite) is asked; a reset is not a sign-up.
      if (purpose === 'invite') subscribeIfAsked(subscribe, user.email);
    } catch (error: unknown) {
      sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Could not set the password');
    }
  });

  router.post('/logout', async (req: AppRequest, res: FastifyReply) => {
    await auth.logout(readCookie(req, SESSION_COOKIE));
    clearCookie(res, SESSION_COOKIE, { path: '/' });
    res.send({ ok: true });
  });

  /** End this person's sessions everywhere else (another browser, a lost laptop). */
  router.post('/sign-out-others', async (req: AppRequest, res: FastifyReply) => {
    const token = readCookie(req, SESSION_COOKIE);
    const user = await auth.getUserByToken(token);
    if (!user || !token) {
      sendError(res, 'unauthenticated', 'Authentication required');
      return;
    }
    res.send({ signedOut: await auth.signOutOtherSessions(user.id, token) });
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
