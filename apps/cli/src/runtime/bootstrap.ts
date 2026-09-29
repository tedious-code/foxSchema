import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readConfig, DEFAULT_DB_PATH } from './config';
import { getDek } from './keyring';

/**
 * Push the stored config + key into process.env so the shared backend modules
 * (getStore / crypto / connection-store) — which read everything from env — run
 * unchanged in the CLI and the server.
 * Returns false if the key couldn't be resolved.
 */
export function applyEnv(): boolean {
  const c = readConfig();
  const dek = process.env.FOXSCHEMA_KEY || getDek(c.email) || '';
  if (dek) process.env.APP_ENCRYPTION_KEY = dek;
  if (c.email) process.env.APP_USER_EMAIL = c.email;
  process.env.APP_KEY_SCHEME = c.keyScheme;
  process.env.APP_DB_ENGINE = c.dbEngine;
  if (c.dbEngine === 'sqlite') {
    const dbPath = c.dbPath || DEFAULT_DB_PATH;
    mkdirSync(dirname(dbPath), { recursive: true }); // node:sqlite won't create the dir
    process.env.APP_DB_PATH = dbPath;
  } else if (c.dbUrl) {
    process.env.APP_DB_URL = c.dbUrl;
  }
  process.env.EDITION = process.env.EDITION || 'community';
  return !!dek;
}

/**
 * Guard for commands that need the store: ensure setup ran and apply env.
 *
 * The one place these two checks live. `getContext()` used to repeat them with
 * its own wording, and the two had already drifted apart.
 */
export function requireReady(): void {
  if (!readConfig().setupComplete) {
    throw new Error('Not set up yet — run `fox setup` first.');
  }
  if (!applyEnv()) {
    throw new Error(
      'Encryption key unavailable (keychain locked or on a different machine). ' +
        'Re-run `fox setup`, or set FOXSCHEMA_KEY for headless use.'
    );
  }
}

/**
 * Non-throwing counterpart to requireReady(), for the TUI: a thrown error there
 * would crash the whole interactive session instead of landing on a helpful
 * screen. Line commands use requireReady(), directly or through getContext().
 */
export function checkReady(): { ready: true } | { ready: false; reason: 'not-set-up' | 'key-unreachable' } {
  if (!readConfig().setupComplete) return { ready: false, reason: 'not-set-up' };
  if (!applyEnv()) return { ready: false, reason: 'key-unreachable' };
  return { ready: true };
}
