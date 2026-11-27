import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { startUiServer, getLogger } from '@foxschema/server';

/**
 * Production web entry (Docker / self-host / CLI child process).
 * Serves the built Vite frontend AND /api from a single origin.
 *
 * createApp() (shared with the tests) is left exactly
 * as-is; static serving is layered on top in startUiServer().
 */

// Read a local .env if present (dev convenience); real deployments pass env directly.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — fine */
}

// Ensure an install encryption key exists on first boot so initial installs
// work without manual env setup, and share it with the workflow engine when
// FOXFLOW_ENCRYPTION_KEY is not set separately.
if (!process.env.APP_ENCRYPTION_KEY) {
  const keyFile =
    process.env.APP_ENCRYPTION_KEY_FILE ||
    (process.env.APP_DB_PATH && process.env.APP_DB_PATH !== ':memory:'
      ? resolve(dirname(process.env.APP_DB_PATH), '.app_encryption_key')
      : '/data/.app_encryption_key');
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured key file path
    const saved = readFileSync(keyFile, 'utf8').trim();
    if (saved) process.env.APP_ENCRYPTION_KEY = saved;
  } catch {
    /* key file does not exist yet */
  }
  if (!process.env.APP_ENCRYPTION_KEY) {
    const generated = randomBytes(32).toString('hex');
    process.env.APP_ENCRYPTION_KEY = generated;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured key file path
      mkdirSync(dirname(keyFile), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured key file path
      writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });
      console.log(`[fox] Generated APP_ENCRYPTION_KEY and saved to ${keyFile}`);
    } catch {
      console.warn(
        `[fox] Generated an in-memory APP_ENCRYPTION_KEY (could not write ${keyFile}). Set APP_ENCRYPTION_KEY or mount /data to persist it.`
      );
    }
  }
}
if (!process.env.FOXFLOW_ENCRYPTION_KEY && process.env.APP_ENCRYPTION_KEY) {
  process.env.FOXFLOW_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY;
}

// This app owns its build output, so this entry is the right place to know
// where it is: src/ → ../dist. @foxschema/server deliberately has no default.
const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

const { port, close } = await startUiServer({ staticDir });
getLogger().info(
  { component: 'server', port, url: `http://localhost:${port}` },
  'Fox Schema listening'
);

const shutdown = async (signal: string) => {
  getLogger().info({ component: 'server', signal }, 'shutting down — closing connection pools');
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
