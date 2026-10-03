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
import { join } from 'node:path';
import type http from 'node:http';
import { ConnectionFactory, setupDb2ClientEnv } from '@foxschema/db';
import { createFastifyApp } from './api/fastify-server';
import { sweepOnBoot } from './api/server';
import { assertListenPosture, defaultListenHost } from './api/deployment';
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
}

export interface StartedUiServer {
  port: number;
  host: string;
  staticDir: string;
  /** The underlying Node server, already listening. */
  server: http.Server;
  close: () => Promise<void>;
}

export async function startUiServer(opts: StartUiServerOptions = {}): Promise<StartedUiServer> {
  const host = opts.host ?? process.env.LISTEN_HOST ?? defaultListenHost();
  assertListenPosture(host);
  setupDb2ClientEnv();

  // The caller supplies the frontend's location. This package must not assume
  // where an application keeps its build output, so there is no default: the
  // CLI resolves the packaged or workspace dist, and apps/web's serve entry
  // passes its own.
  const staticDir = opts.staticDir || process.env.STATIC_DIR;
  if (!staticDir) {
    throw new Error(
      'startUiServer needs a staticDir: pass it, or set STATIC_DIR to the built frontend.'
    );
  }

  // Static serving and the SPA fallback are configured in createFastifyApp.
  // Fastify allows only one not-found handler per instance, so it has a single
  // owner there.
  const app = await createFastifyApp({ staticDir });

  sweepOnBoot();

  const requested =
    opts.port ?? (Number(process.env.API_PORT || process.env.PORT) || DEFAULT_API_PORT);
  await app.listen({ port: requested, host });

  // Report the port that was actually bound. A requested port of 0 means "any
  // free port", so the caller needs the resolved value to connect.
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : requested;

  const close = async () => {
    await ConnectionFactory.closeAll();
    await app.close();
  };

  return { port, host, staticDir, server: app.server, close };
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
