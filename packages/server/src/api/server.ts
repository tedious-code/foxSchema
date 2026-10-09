/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The API's route tree: what exists, and which guards stand in front of it.
 *
 * This builds a declaration of the routes. `bindRoutes` registers each one with
 * Fastify, using that route's guards as its `preHandler` chain.
 *
 * Mount order matters:
 *
 *  - SSO is mounted before the base auth router so its sub-paths take
 *    precedence.
 *  - Auth and signup are mounted before any guard, since a caller cannot be
 *    signed in yet.
 *  - The session guard runs before the rate limiter so the limiter can count
 *    requests per user rather than per IP.
 */
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../platform/http/types';
import { ConnectionModule, ConnectionFactory } from '@foxschema/db';
import { AuthModule } from '../features/auth/auth.service';
import { ConnectionStore } from '../features/connections/connection-store.service';
import { sweepOrphanedUploadFiles } from '../features/files/file-session.service';
import { UserModule } from '../features/users/user.service';
import { createApiRoutes } from './routes';
import { defaultApiRateLimit } from '../platform/guards/rate-limit';
import { createAuthRoutes, authGuard, requireRegisteredAccount } from '../features/auth/auth.routes';
import { createSsoRoutes } from '../features/auth/sso.routes';
import { createSignInSettingsRoutes } from '../features/auth/sign-in-settings.routes';
import { createGitRoutes } from '../features/git/git.routes';
import { makeConnectionResolver } from '../platform/db/resolve';
import { createConnectionStoreRoutes } from '../features/connections/connections.routes';
import { createAppSecretsRoutes } from '../features/admin/app-secrets.routes';
import { createUserRoutes } from '../features/users/user.routes';
import { createBackupSettingsRoutes } from '../features/backup/backup-settings.routes';
import { createAdminRoutes } from '../features/admin/admin.routes';
import { createSignupRoutes } from '../features/users/signup-wizard.routes';
import { createFileQueryRoutes } from '../features/files/files.routes';
import { createWorkflowRoutes } from '../features/workflow/workflow.routes';
import { createWorkflowInternalRoutes } from '../features/workflow/workflow-internal.routes';
import { WORKFLOW_INTERNAL_PREFIX } from '@foxschema/workflow-contract';
import { DEFAULT_API_PORT } from '../defaultApiPort';
import { assertListenPosture } from './deployment';
import { AppSecretsStore } from '../features/admin/app-secrets.service';
import { resolveAppVersion } from '../internal/updates.service';
import { asAppLogger, getLogger } from '../platform/logger/logger';
import { Router, type RouteDefinition } from '../platform/http/router';

/** Largest request body the API accepts. Enforced by Fastify as bytes arrive. */
export const BODY_LIMIT = process.env.FOX_BODY_LIMIT || '10mb';

/** Every route the API serves, flattened to absolute paths with their guards. */
export function buildApiRoutes(): RouteDefinition[] {
  // The driver runtime logs through whatever it is given; without this it stays
  // silent. Installed here so query timing is on wherever the app is built.
  ConnectionFactory.useLogger(asAppLogger(getLogger()));

  const root = Router();
  const connectionModule = new ConnectionModule();

  // Public liveness check. Includes the version so `foxschema open` can detect
  // a stale pre-upgrade process on this port.
  root.get('/api/health', (_req: AppRequest, res: FastifyReply) => {
    res.send({ ok: true, version: resolveAppVersion() });
  });

  // Kept for clients built before sign-in became mandatory: every install now
  // signs in. First-run setup state is GET /api/auth/setup.
  root.get('/api/config', (_req: AppRequest, res: FastifyReply) => {
    res.send({ localSingleUser: false });
  });

  // Auth endpoints are public. SSO is mounted first so its sub-paths take
  // precedence over the base auth router.
  const auth = new AuthModule();
  root.use('/api/auth/sso', createSsoRoutes(auth));
  root.use('/api/auth', createAuthRoutes(auth));
  // First-open email subscriber wizard — must stay public (before login).
  root.use('/api/signup', createSignupRoutes());
  // Called by the workflow engine, never a browser: no session, the shared
  // service token instead.
  root.use(WORKFLOW_INTERNAL_PREFIX, createWorkflowInternalRoutes());

  // Every install requires sign-in, desktop and CLI included. There used to be
  // a single-user mode that attached a built-in local user to every request;
  // anyone who could reach the port was that user.
  const userGuard = authGuard(auth);
  // Who can get in is decided by someone with an account, never by a launch link.
  const registeredOnly = requireRegisteredAccount();

  const connectionStore = new ConnectionStore();
  root.use('/api/connections', userGuard, createConnectionStoreRoutes(connectionStore));
  root.use('/api/app-secrets', userGuard, createAppSecretsRoutes(new AppSecretsStore()));
  root.use('/api/user', userGuard, createUserRoutes(new UserModule()));
  root.use('/api/backup-settings', userGuard, createBackupSettingsRoutes());
  root.use('/api/admin/sign-in', userGuard, registeredOnly, createSignInSettingsRoutes());
  root.use('/api/admin', userGuard, registeredOnly, createAdminRoutes());
  root.use('/api/git', userGuard, createGitRoutes(makeConnectionResolver(connectionModule, connectionStore).resolveRef));
  // FoxWorkflow control plane (settings + engine health proxy).
  root.use('/api/workflow', userGuard, createWorkflowRoutes());
  // CSV / JSON / fixed-width text → temp SQLite credential for SQL Editor.
  root.use('/api/files', userGuard, createFileQueryRoutes(connectionStore));

  const guard = userGuard;
  // The guard runs first so the limiter can charge an authenticated user
  // rather than lumping everyone behind one shared IP bucket.
  root.use('/api', guard, defaultApiRateLimit(), createApiRoutes(connectionModule, connectionStore));

  return root.flatten();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Delete expired sessions and spent sign-in codes; never fails the caller. */
async function purgeExpiredAuth(): Promise<void> {
  try {
    const { sessions, codes } = await new AuthModule().purgeExpired();
    if (sessions + codes > 0) {
      getLogger().info({ component: 'auth', sessions, codes }, 'purged expired sessions and codes');
    }
  } catch (error: unknown) {
    getLogger().warn({ component: 'auth', err: error }, 'session purge skipped');
  }
}

/**
 * Housekeeping at boot.
 *
 * Partial uploads are tracked in memory, so any `.part` file on disk at startup
 * belongs to no live session and can be deleted. Startup is the only point at
 * which that is safe to assume.
 *
 * Expired sessions and used or expired sign-in codes are deleted now and then
 * daily; otherwise those tables only grow.
 */
export function sweepOnBoot(): void {
  try {
    const swept = sweepOrphanedUploadFiles();
    if (swept > 0) {
      getLogger().info({ component: 'uploads', removed: swept }, 'swept orphaned upload parts');
    }
  } catch (error: unknown) {
    // Never block boot on temp-dir housekeeping.
    getLogger().warn({ component: 'uploads', err: error }, 'upload sweep skipped');
  }
  void purgeExpiredAuth();
  setInterval(() => void purgeExpiredAuth(), DAY_MS).unref();
}

/** Drain connection pools on shutdown so the process exits cleanly. */
export function installShutdownHandlers(close: () => Promise<void> | void): void {
  const shutdown = async (signal: string) => {
    getLogger().info({ component: 'server', signal }, 'shutting down — closing connection pools');
    await ConnectionFactory.closeAll();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** API-only server, used by `npm run dev:api`. */
export async function startServer(
  port = Number(process.env.API_PORT) || DEFAULT_API_PORT
): Promise<void> {
  const host = process.env.LISTEN_HOST ?? '127.0.0.1';
  assertListenPosture(host);
  const { createFastifyApp } = await import('./fastify-server');
  const app = await createFastifyApp({});
  sweepOnBoot();
  await app.listen({ port, host });
  getLogger().info(
    { component: 'server', port, url: `http://localhost:${port}` },
    'Fox API listening'
  );
  installShutdownHandlers(() => app.close());
}
