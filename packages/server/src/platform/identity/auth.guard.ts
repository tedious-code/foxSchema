/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The session guard every protected route runs behind, and the cookie
 * helpers it shares with the sign-in routes: who is calling, in which
 * workspace, with which permissions.
 */
import { setCookie } from '../http/reply';
import type { FastifyReply } from 'fastify';
import type { AppRequest, AuthedRequest, NextFunction } from '../http/types';
import type { Permission, WorkspaceRole } from '@foxschema/shared';
import { type AuthModule, SESSION_COOKIE, SESSION_MAX_AGE_MS, type AuthUser } from './auth.service';
import { sendError } from '../http/respond';
import { ServiceError } from '../contracts/actor';

/** Put the resolved session user's identity + grants on the request. */
export function attachAuthUser(
  user: AuthUser,
  req: AuthedRequest,
  launchSession = false,
  workspace?: { id: string; role: WorkspaceRole; permissions: Permission[] }
): void {
  req.userId = user.id;
  req.appRole = user.role;
  req.permissions = new Set(workspace?.permissions ?? user.permissions);
  req.launchSession = launchSession;
  req.workspaceId = workspace?.id;
  req.workspaceRole = workspace?.role;
}

/** The workspace a request asks for, by id; empty means "the default one". */
export function requestedWorkspace(req: AppRequest): string | undefined {
  const raw = req.headers['x-fox-workspace'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value || undefined;
}

const REGISTER_TO_CONTINUE = 'Create your account to keep using Fox. Your connections and history stay as they are.';

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

/**
 * Guard for protected routes — attaches userId + RBAC or 401s.
 *
 * A launch session passes until its grace period is over; from then on the
 * owner has to create the account before anything else works.
 */
export function authGuard(auth: AuthModule) {
  return async (req: AuthedRequest, res: FastifyReply, next: NextFunction) => {
    try {
      const session = await auth.resolveSession(readCookie(req, SESSION_COOKIE));
      if (!session) {
        sendError(res, 'unauthenticated', 'Authentication required');
        return;
      }
      if (session.launch && (await auth.registrationState()).required) {
        sendError(res, 'forbidden', REGISTER_TO_CONTINUE);
        return;
      }
      let inWorkspace: Awaited<ReturnType<AuthModule['inWorkspace']>>;
      try {
        inWorkspace = await auth.inWorkspace(session.user, requestedWorkspace(req));
      } catch (err) {
        if (err instanceof ServiceError) {
          sendError(res, err.code, err.message);
          return;
        }
        throw err;
      }
      const { workspace, permissions } = inWorkspace;
      attachAuthUser(session.user, req, session.launch, { id: workspace.id, role: workspace.role, permissions });
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * For routes that change who can get in: adding and managing users, and
 * sign-in settings (SSO, mail, the public URL). A launch session never may,
 * whatever its grace period: the owner creates their own account first.
 * Mounted after `authGuard`.
 */
export function requireRegisteredAccount() {
  return (req: AuthedRequest, res: FastifyReply, next: NextFunction) => {
    if (req.launchSession) {
      sendError(res, 'forbidden', 'Create your account first: managing users and sign-in needs one.');
      return;
    }
    next();
  };
}
