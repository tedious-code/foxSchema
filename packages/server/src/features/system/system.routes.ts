/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The app about itself: liveness and version, updates, where its metadata
 * lives, and what long-running work is in flight. No product domain owns
 * these, so they live here rather than in the HTTP bootstrap.
 */
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { AppSettingsStore } from '../../platform/settings/app-settings.service';
import { targetLocks } from '../../platform/guards/target-lock';
import { isLocalSingleUser } from '../../platform/runtime/deployment';
import { sendError } from '../../platform/http/respond';
import { keySchemeInfo } from '../../platform/crypto/crypto';
import { getMetadataDbConfig, SUPPORTED_ENGINES, type DbEngine } from '../../database/config';
import { createMetadataStore } from '../../database/stores/registry';
import {
  applyNpmGlobalUpdate,
  canSelfUpdate,
  checkForUpdate,
  clearUpdateCache,
  MANUAL_UPDATE_COMMAND,
  resolveAppVersion,
  scheduleUiRelaunch,
} from '../../internal/updates.service';

/** Before sign-in: liveness, and the config older clients still ask for. */
export function createSystemPublicRoutes(): Router {
  const root = Router();
  // Public liveness check. Includes the version so `foxschema open` can detect
  // a stale pre-upgrade process on this port.
  root.get('/health', (_req: AppRequest, res: FastifyReply) => {
    res.send({ ok: true, version: resolveAppVersion() });
  });

  // Kept for clients built before sign-in became mandatory: every install now
  // signs in. First-run setup state is GET /api/auth/setup.
  root.get('/config', (_req: AppRequest, res: FastifyReply) => {
    res.send({ localSingleUser: false });
  });

  return root;
}

/** Signed in: updates, app info, the metadata-database probe, activity. */
export function createSystemRoutes(appSettings = new AppSettingsStore()): Router {
  const router = Router();

  // In-app update check — compares the running version against npm (default).
  router.get('/updates/check', async (_req: AppRequest, res: FastifyReply) => {
    res.send(await checkForUpdate());
  });

  // One-click self-update for local npm CLI installs (`foxschema open`).
  // Runs `npm install -g foxschema@latest`, then relaunches the UI server.
  router.post('/updates/apply', async (_req: AppRequest, res: FastifyReply) => {
    if (!canSelfUpdate()) {
      sendError(
        res,
        'forbidden',
        'Automatic update is only available for local CLI installs. ' +
          `Run in a terminal: ${MANUAL_UPDATE_COMMAND}`,
        { extra: { upgradeCommand: MANUAL_UPDATE_COMMAND } }
      );
      return;
    }
    const result = await applyNpmGlobalUpdate();
    if (!result.ok) {
      res.status(500).send(result);
      return;
    }
    clearUpdateCache();
    res.send(result);
    // Respond first, then exit + relaunch so the client can start polling.
    scheduleUiRelaunch();
  });

  // Non-secret info about where the app's metadata DB lives and how the
  // credential-encryption key is bound — for the "Database & Security" settings
  // section. Never exposes the key itself.
  router.get('/app-info', async (_req: AppRequest, res: FastifyReply) => {
    const cfg = getMetadataDbConfig();
    const key = keySchemeInfo();
    // Persist a durable record of the active config (useful for later tooling).
    try {
      await appSettings.set('db.engine', cfg.engine);
      if (cfg.path) await appSettings.set('db.path', cfg.path);
      if (key.boundEmail) await appSettings.set('key.boundEmail', key.boundEmail);
      await appSettings.set('key.scheme', key.scheme);
    } catch {
      /* best-effort; never block the response */
    }
    res.send({
      version: resolveAppVersion(),
      features: { fileQuery: true },
      db: { engine: cfg.engine, location: cfg.engine === 'sqlite' ? cfg.path ?? '(default)' : cfg.url ?? '' },
      security: { keyScheme: key.scheme, emailBound: key.emailBound, boundEmail: key.boundEmail },
    });
  });

  // Validate a candidate metadata-DB engine/URL before the user switches to it.
  // Opens a throwaway connection (no migrations, no effect on the live store).
  // Restricted to the local/community edition — on multi-user web the metadata
  // DB is ops-managed, and a connection probe would be an SSRF vector.
  router.post('/db/test', async (req: AppRequest, res: FastifyReply) => {
    // The restriction above was documented but never implemented. On a
    // multi-user deployment this handler dials any host:port the caller names
    // and reports, through the error text, whether something answered — an
    // SSRF and internal port-scan primitive, on a route that carries no
    // permission check. Local single-user is the only place it belongs.
    if (!isLocalSingleUser()) {
      sendError(res, 'forbidden', 'Changing the metadata database is not available on this deployment.');
      return;
    }
    const { engine, url, path } = req.body as { engine?: string; url?: string; path?: string };
    if (!engine || !SUPPORTED_ENGINES.includes(engine as DbEngine)) {
      sendError(res, 'invalid_input', `Unsupported engine. Supported: ${SUPPORTED_ENGINES.join(', ')}.`);
      return;
    }
    if ((engine === 'postgres' || engine === 'mysql') && !url) {
      sendError(res, 'invalid_input', 'A connection string is required.');
      return;
    }
    let store;
    try {
      store = createMetadataStore({ engine: engine as DbEngine, url, path });
      await store.init();
      res.send({ ok: true });
    } catch (error: unknown) {
      res.send({ ok: false, error: error instanceof Error ? error.message : 'Connection failed' });
    } finally {
      try {
        await store?.close();
      } catch {
        /* ignore */
      }
    }
  });

  /**
   * What long-running work is in flight, for the UI's activity indicator.
   * Cheap and read-only — safe to poll.
   */
  router.get('/activity', (_req: AppRequest, res: FastifyReply) => {
    const running = targetLocks.active();
    res.send({
      count: running.length,
      tasks: running.map((t) => ({
        operation: t.operation,
        label: t.label,
        startedAt: t.startedAt,
        // The key names host/database/schema, never a credential.
        target: t.key,
      })),
    });
  });

  return router;
}
