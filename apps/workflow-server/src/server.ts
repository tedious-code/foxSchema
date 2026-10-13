/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/server.ts).
 *
 * The engine API listens on HOST:PORT (loopback by default). Setting
 * INGRESS_PORT moves webhook and API-endpoint ingress to a listener of its
 * own on INGRESS_HOST, which is the one to put behind a public reverse proxy:
 * callers from outside never share a port with the engine API, and FoxSchema
 * itself never carries webhook traffic.
 */
import type { FastifyInstance } from 'fastify';
import { WORKFLOW_ENGINE_TOKEN_ENV } from '@foxschema/workflow-contract';
import { buildApp, buildIngressApp, openApiListenProblem } from './app.js';
import { createContext } from './context.js';
import { attachEngineSettings } from './engine-settings.js';

const port = Number(process.env.PORT ?? 8081);
const host = process.env.HOST ?? '127.0.0.1';
const ingressPort = process.env.INGRESS_PORT ? Number(process.env.INGRESS_PORT) : undefined;
const ingressHost = process.env.INGRESS_HOST ?? '127.0.0.1';
/** Hard cap on graceful shutdown; tsx watch SIGKILLs at 5s. */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.FOXFLOW_SHUTDOWN_TIMEOUT_MS ?? 3000);

const openApi = openApiListenProblem(host, process.env[WORKFLOW_ENGINE_TOKEN_ENV]);
if (openApi) {
  console.error(openApi);
  process.exit(1);
}

const ctx = createContext();
const detachSettings = attachEngineSettings(ctx);
const app = buildApp(ctx, { ingress: ingressPort === undefined });
const ingress: FastifyInstance | undefined =
  ingressPort === undefined ? undefined : buildIngressApp(ctx);

async function start(): Promise<void> {
  console.log(`workflow-server listening on ${await app.listen({ port, host })}`);
  if (ingress) {
    console.log(`workflow-server ingress listening on ${await ingress.listen({ port: ingressPort, host: ingressHost })}`);
  }
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Graceful shutdown. Without this the process ignores SIGTERM (tsx's preflight
 * registers its own listener, which suppresses Node's default exit-on-signal),
 * so `tsx watch` restarts hung for 5s and then SIGKILLed — losing the onClose
 * hook that stops cron, drains runs, and closes SQLite.
 *
 * `close()` is still bounded: a wedged run or a stuck socket must not
 * outlive the timeout, so we force-exit rather than wait to be killed.
 */
let closing = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  const forced = setTimeout(() => {
    console.error(`workflow-server: ${signal} shutdown timed out, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  try {
    // Stop taking new trigger requests before the API app drains runs and
    // closes the stores they write to.
    await ingress?.close();
    await app.close();
    await detachSettings();
    process.exit(0);
  } catch (error) {
    console.error('workflow-server: shutdown failed', error);
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(signal));
}
