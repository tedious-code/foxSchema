#!/usr/bin/env node
/**
 * Detached UI server process entry for `foxschema open`.
 * Env (API_PORT, STATIC_DIR, APP_ENCRYPTION_KEY, APP_DB_*) is set by the parent.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUiServer } from '@foxschema/server';
import { usePackagedSandboxWorker } from '../runtime/sandboxWorker';

// Before the server starts: the workflow engine reads this when it boots.
usePackagedSandboxWorker(dirname(fileURLToPath(import.meta.url)));

// So Activity Monitor / `ps` / Task Manager “window title” can identify us
// (Image Name on Windows is still node.exe — see docs).
try {
  process.title = 'foxschema';
} catch {
  /* ignore */
}

const port = Number(process.env.API_PORT || process.env.PORT) || 3210;
const host = process.env.LISTEN_HOST || '127.0.0.1';
const staticDir = process.env.STATIC_DIR;

// startUiServer is async now — it resolves once Fastify is actually listening,
// so there is no 'listening' event left to wait for.
let close: () => Promise<void>;
try {
  ({ close } = await startUiServer({ port, host, staticDir }));
  console.log(`Fox Schema UI server listening on http://${host}:${port}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

const shutdown = async () => {
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
