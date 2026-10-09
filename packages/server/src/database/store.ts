import { fileURLToPath } from 'node:url';
import { getMetadataDbConfig } from './config';
import { createMetadataStore } from './stores/registry';
import { runMigrations } from './schema';
import { seedDefaultRolePermissions, backfillDatagridRolePermissions } from '../features/authorization/rbac.service';
import { backfillAdminPolicy } from '../features/authorization/admin-policy.service';
import type { MetadataStore } from './stores/types';

// Default SQLite location, anchored to this module so it's independent of the
// process working directory. Override with APP_DB_PATH (or switch engines with
// APP_DB_ENGINE + APP_DB_URL).
const DEFAULT_SQLITE_PATH = fileURLToPath(new URL('./foxschema.db', import.meta.url));

let storePromise: Promise<MetadataStore> | null = null;

/**
 * The app metadata store (users, connections, preferences, sessions, history,
 * settings) — separate from the user databases being compared. Lazily connects
 * + migrates once; the same instance is reused. This is the app's own database,
 * pluggable across engines via the provider registry.
 */
export function getStore(): Promise<MetadataStore> {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    const cfg = getMetadataDbConfig();
    if (cfg.engine === 'sqlite' && !cfg.path) cfg.path = DEFAULT_SQLITE_PATH;
    const store = createMetadataStore(cfg);
    await store.init();
    await runMigrations(store);
    await seedDefaultRolePermissions(store);
    await backfillDatagridRolePermissions(store);
    await backfillAdminPolicy(store);
    return store;
  })().catch((err) => {
    storePromise = null; // allow a retry after a failed connect/migrate
    throw err;
  });
  return storePromise;
}
