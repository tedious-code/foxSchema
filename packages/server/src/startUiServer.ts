/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The single-origin server: the built frontend and the API on one port.
 *
 * Used by Docker, by `apps/web`'s serve entry, and by the CLI's `foxschema
 * open` child process.
 */
import type http from 'node:http';
import { API_CONTRACT } from '@foxschema/shared';
import { ConnectionFactory } from '@foxschema/db';
import { registerDb2 } from '@foxschema/db-db2';
import { createFastifyApp } from './api/fastify-server';
import { sweepOnBoot } from './api/server';
import { resolveAppVersion } from './internal/updates.service';
import { getLogger } from './platform/logger/logger';
import { assertListenPosture, defaultListenHost } from './platform/runtime/deployment';
import {
  UI_BUNDLE_CHECK_INTERVAL_MS,
  checkAndUpdateUiBundle,
  isUiUpdatesEnabled,
  recordUiUpdateError,
  resolveServingUiDir,
  resolveUiBundlesDir,
  resolveUiPublicKeys,
} from './platform/ui-bundle';
import { DEFAULT_API_PORT } from './defaultApiPort';

export interface StartUiServerOptions {
  /** Listen port. Defaults to API_PORT / PORT / DEFAULT_API_PORT (3210). */
  port?: number;
  /**
   * Absolute path to the built frontend. Falls back to STATIC_DIR; there is
   * no default, because this package must not know where an app puts its dist.
   */
  staticDir?: string;
  /**
   * Bind address. Defaults to 0.0.0.0 in production, so Docker can reach it,
   * and to 127.0.0.1 otherwise; a network address outside production is refused.
   */
  host?: string;
  /** Override UI bundle cache root (defaults to FOX_UI_DIR or alongside the metadata DB). */
  uiBundleDir?: string;
}

export interface StartedUiServer {
  port: number;
  host: string;
  staticDir: string;
  uiSource: 'cdn' | 'packaged';
  uiVersion: string;
  /** The underlying Node server, already listening. */
  server: http.Server;
  close: () => Promise<void>;
}

export async function startUiServer(opts: StartUiServerOptions = {}): Promise<StartedUiServer> {
  const host = opts.host ?? process.env.LISTEN_HOST ?? defaultListenHost();
  assertListenPosture(host);
  registerDb2();

  // The caller supplies the frontend's location. This package must not assume
  // where an application keeps its build output, so there is no default: the
  // CLI resolves the packaged or workspace dist, and apps/web's serve entry
  // passes its own.
  const packagedDir = opts.staticDir || process.env.STATIC_DIR;
  if (!packagedDir) {
    throw new Error(
      'startUiServer needs a staticDir: pass it, or set STATIC_DIR to the built frontend.'
    );
  }

  const packagedVersion = resolveAppVersion();
  const bundleRootDir = opts.uiBundleDir ?? resolveUiBundlesDir();
  const updatesEnabled = isUiUpdatesEnabled();
  const serving = resolveServingUiDir({
    rootDir: bundleRootDir,
    packagedDir,
    packagedVersion,
    apiContract: API_CONTRACT,
    updatesEnabled,
  });
  process.env.FOX_PACKAGED_STATIC_DIR = packagedDir;

  // Static serving and the SPA fallback are configured in createFastifyApp.
  // Fastify allows only one not-found handler per instance, so it has a single
  // owner there.
  const app = await createFastifyApp({
    staticDir: serving.dir,
    packagedStaticDir: serving.source === 'cdn' ? packagedDir : undefined,
  });

  sweepOnBoot();

  const requested =
    opts.port ?? (Number(process.env.API_PORT || process.env.PORT) || DEFAULT_API_PORT);
  await app.listen({ port: requested, host });

  let uiTimer: ReturnType<typeof setInterval> | null = null;
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test' && updatesEnabled && resolveUiPublicKeys().length > 0) {
    const runCheck = () =>
      void checkAndUpdateUiBundle({
        rootDir: bundleRootDir,
        packagedDir,
        packagedVersion,
        apply: true,
      }).catch((err: unknown) => {
        recordUiUpdateError(bundleRootDir, err);
        getLogger().warn({ component: 'ui-bundle', err }, 'Cloudflare UI bundle check failed');
      });
    runCheck();
    uiTimer = setInterval(runCheck, UI_BUNDLE_CHECK_INTERVAL_MS);
    uiTimer.unref();
  }

  // Report the port that was actually bound. A requested port of 0 means "any
  // free port", so the caller needs the resolved value to connect.
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : requested;

  const close = async () => {
    if (uiTimer) clearInterval(uiTimer);
    await ConnectionFactory.closeAll();
    await app.close();
  };

  return {
    port,
    host,
    staticDir: serving.dir,
    uiSource: serving.source,
    uiVersion: serving.version,
    server: app.server,
    close,
  };
}

/**
 * Which HTTP server to run.
 *
 * There is only one now. Kept as a function because the CLI and the Docker
 * entrypoint both report it, and because `FOX_SERVER` may still be set in an
 * existing deployment's environment — answering honestly beats pretending the
 * flag still switches anything.
 */
export function serverFlavour(): 'fastify' {
  return 'fastify';
}
