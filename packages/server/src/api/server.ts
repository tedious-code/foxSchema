/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The API's route tree, and boot-time housekeeping.
 *
 * The tree comes from the feature registry (`app/feature-registry.ts`): every
 * feature's module, composed with the guards its mounts ask for. `bindRoutes`
 * registers each route with Fastify, using that route's guards as its
 * `preHandler` chain. Mount order, the session guard and the shared rate
 * limit are the registry's job, not this file's.
 */
import { ConnectionFactory } from '@foxschema/db';
import { AuthModule } from '../platform/identity/auth.service';
import { sweepOrphanedUploadFiles } from '../features/files';
import { composeFeatures, createFeatureContext, FEATURES } from '../app/feature-registry';
import { DEFAULT_API_PORT } from '../defaultApiPort';
import { assertListenPosture } from '../platform/runtime/deployment';
import { asAppLogger, getLogger } from '../platform/logger/logger';
import type { RouteDefinition } from '../platform/http/router';

/** Largest request body the API accepts. Enforced by Fastify as bytes arrive. */
export const BODY_LIMIT = process.env.FOX_BODY_LIMIT || '10mb';

/** Every route the API serves, flattened to absolute paths with their guards. */
export function buildApiRoutes(): RouteDefinition[] {
  // The driver runtime logs through whatever it is given; without this it stays
  // silent. Installed here so query timing is on wherever the app is built.
  ConnectionFactory.useLogger(asAppLogger(getLogger()));
  return composeFeatures(FEATURES, createFeatureContext()).flatten();
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
