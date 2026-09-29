import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readConfig, writeConfig, DEFAULT_DB_PATH } from './config';
import { getDek } from './keyring';
import { applyEnv } from './bootstrap';
import { DATA_DIR, LOCAL_KEY_FILE } from './paths';

function readLocalKeyFile(): string | null {
  try {
    const raw = readFileSync(LOCAL_KEY_FILE, 'utf8').trim();
    return /^[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : null;
  } catch {
    return null;
  }
}

function writeLocalKeyFile(hex: string): void {
  mkdirSync(dirname(LOCAL_KEY_FILE), { recursive: true });
  writeFileSync(LOCAL_KEY_FILE, hex + '\n', { mode: 0o600 });
}

/**
 * Ensure encryption + metadata DB env is ready for the browser UI launcher.
 * Preference order:
 *   1. Existing CLI setup (keychain / FOXSCHEMA_KEY) via applyEnv()
 *   2. File-backed key under XDG data (Docker-like, no interactive setup)
 *   3. Generate a new file-backed v1 key and mark setup complete
 */
export function ensureUiEnv(): { source: 'keychain' | 'env' | 'file' | 'generated' } {
  mkdirSync(DATA_DIR, { recursive: true });

  if (process.env.FOXSCHEMA_KEY || process.env.APP_ENCRYPTION_KEY) {
    applyEnv();
    if (!process.env.APP_ENCRYPTION_KEY && process.env.FOXSCHEMA_KEY) {
      process.env.APP_ENCRYPTION_KEY = process.env.FOXSCHEMA_KEY;
    }
    process.env.EDITION = process.env.EDITION || 'community';
    return { source: process.env.FOXSCHEMA_KEY ? 'env' : 'keychain' };
  }

  const c = readConfig();
  if (c.setupComplete && c.email) {
    const dek = getDek(c.email);
    if (dek) {
      applyEnv();
      return { source: 'keychain' };
    }
  }

  let key = readLocalKeyFile();
  let source: 'file' | 'generated' = 'file';
  if (!key) {
    key = randomBytes(32).toString('hex');
    writeLocalKeyFile(key);
    source = 'generated';
  }

  process.env.APP_ENCRYPTION_KEY = key;
  process.env.APP_KEY_SCHEME = 'v1';
  process.env.APP_DB_ENGINE = c.dbEngine || 'sqlite';
  const dbPath = c.dbPath || DEFAULT_DB_PATH;
  mkdirSync(dirname(dbPath), { recursive: true });
  process.env.APP_DB_PATH = dbPath;
  process.env.EDITION = process.env.EDITION || 'community';
  process.env.LOCAL_SINGLE_USER = 'true';

  if (!c.setupComplete || !existsSync(LOCAL_KEY_FILE)) {
    writeConfig({
      setupComplete: true,
      email: c.email || '',
      dbEngine: 'sqlite',
      dbPath,
      dbUrl: '',
      keyScheme: 'v1',
    });
  }

  return { source };
}
