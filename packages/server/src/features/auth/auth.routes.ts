/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { setCookie, clearCookie } from '../../platform/http/reply';
import type { FastifyReply } from 'fastify';
import type { AppRequest, AuthedRequest, NextFunction } from '../../platform/http/types';
import type { Permission, WorkspaceRole } from '@foxschema/shared';
import { Router } from '../../platform/http/router';
import { AuthModule, SESSION_COOKIE, SESSION_MAX_AGE_MS, SignInLockedError, type AuthUser } from '../../platform/identity/auth.service';
import { AuthMailer } from '../../platform/identity/auth-mail';
import { SignupModule } from '../users/signup-wizard.service';
import { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { sendError } from '../../platform/http/respond';
import { ServiceError } from '../../platform/contracts/actor';
import { rateLimit } from '../../platform/guards/rate-limit';
import { getLogger } from '../../platform/logger/logger';
import { isDirectLocalRequest, launchLinksAllowed, resetSetupCode, setupCode, setupCodeMatches } from '../../platform/identity/setup-code';

import {
  authGuard,
  readCookie,
  requireRegisteredAccount,
  setSessionCookie,
  attachAuthUser,
  requestedWorkspace,
} from '../../platform/identity/auth.guard';

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
    // Someone who came in by launch link already proved they run the install.
    const launched = (await auth.resolveSession(readCookie(req, SESSION_COOKIE)))?.launch === true;
    if (!launched && !isDirectLocalRequest(req) && !setupCodeMatches(code)) {
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
      // The account form already offered Fox news, and a launch session never
      // saw the separate signup wizard: don't ask again on the next load.
      if (launched) {
        signup.skip().catch((error: unknown) => {
          getLogger().warn(
            `Could not record the signup offer as answered: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
      // After the reply: the account exists whether or not the mail goes out,
      // and the app offers to send the code again.
      sendVerificationCode(user).catch((error: unknown) => {
        getLogger().warn(
          `Could not send the email-verification code: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    } catch (error: unknown) {
      sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Setup failed');
    }
  });

  const sendVerificationCode = async (user: AuthUser) =>
    mailer.sendVerification(await auth.issueVerifyCode(user.id));

  /**
   * The launch link `foxschema open` opens: exchange its one-time token for a
   * session as the install's owner, before they have an account.
   *
   * Only on a personal install that listens on this machine alone, and only
   * from this machine. The token is the proof; these keep a leaked one from
   * working anywhere else.
   */
  router.post('/launch', signInLimiter, async (req: AppRequest, res: FastifyReply) => {
    if (!launchLinksAllowed() || !isDirectLocalRequest(req)) {
      sendError(res, 'forbidden', 'Launch links work only on a personal install, from the machine it runs on.');
      return;
    }
    const { token } = (req.body ?? {}) as { token?: unknown };
    try {
      const { user, token: session } = await auth.redeemLaunchToken(token);
      setSessionCookie(res, session);
      res.send({ user });
    } catch (error: unknown) {
      sendError(res, 'unauthenticated', error instanceof Error ? error.message : 'This launch link does not work.');
    }
  });

  const verifyLimiter = rateLimit({ name: 'email-verify', windowMs: 15 * 60 * 1000, max: 10 });

  /** Send (again) the code that verifies the signed-in account's email. */
  router.post('/verify/send', verifyLimiter, async (req: AppRequest, res: FastifyReply) => {
    const session = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
    if (!session || session.launch) {
      sendError(res, 'unauthenticated', 'Sign in to verify your email.');
      return;
    }
    if ((await auth.emailVerification(session.user.id)).verified) {
      res.send({ ok: true, verified: true });
      return;
    }
    try {
      res.send({ ok: true, delivery: await sendVerificationCode(session.user), email: session.user.email });
    } catch (error: unknown) {
      sendError(res, 'unavailable', error instanceof Error ? error.message : 'Could not send the code.');
    }
  });

  /** Enter the code from the verification email. */
  router.post('/verify', verifyLimiter, async (req: AppRequest, res: FastifyReply) => {
    const session = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
    if (!session || session.launch) {
      sendError(res, 'unauthenticated', 'Sign in to verify your email.');
      return;
    }
    const { code } = (req.body ?? {}) as { code?: unknown };
    try {
      await auth.verifyEmail(session.user.id, code);
      res.send({ ok: true, verified: true });
    } catch (error: unknown) {
      sendError(res, 'invalid_input', error instanceof Error ? error.message : 'Could not verify the email.');
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

  /**
   * Who is signed in. A launch session also says when its account is due; an
   * account asked to verify its email says whether it has.
   */
  router.get('/me', async (req: AppRequest, res: FastifyReply) => {
    const session = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
    if (session) {
      const { user, launch } = session;
      const verification = launch ? null : await auth.emailVerification(user.id);
      // A workspace the browser remembers but the account left: answer with
      // the default one, so the app can boot and switch.
      const { workspace, permissions } = await auth
        .inWorkspace(user, requestedWorkspace(req))
        .catch((err: unknown) => {
          if (err instanceof ServiceError && err.code === 'not_found') return auth.inWorkspace(user, undefined);
          throw err;
        });
      res.send({
        user: { ...user, permissions },
        workspace,
        launch,
        registration: launch ? await auth.registrationState() : null,
        emailVerification: verification?.required ? { verified: verification.verified } : null,
      });
      return;
    }
    // Nobody signed in is an answer, not an error: the app asks this on every
    // boot, and a 401 here is logged by the browser as a failed request.
    res.send({ user: null });
  });

  return router;
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
