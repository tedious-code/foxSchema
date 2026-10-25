import {
  type ConnectionOptions,
  type ProviderConnectionSettings,
} from '../../interfaces/schema-provider.interface.js';

/**
 * Connection settings for Redis.
 *
 * `schema` carries the **database number** (0–15 by default), not a name —
 * Redis has no named namespaces. The adapter passes it to SELECT, so a
 * non-numeric value would be ignored rather than fail loudly; keeping it out
 * of the URL and validating it here is the honest place to catch that.
 *
 * `schemaRequired` is false because database 0 is the default and most
 * deployments never leave it.
 */
export const redisSettings: ProviderConnectionSettings = {
  dialect: 'redis',
  label: 'Redis',
  defaultPort: 6379,
  defaultSchema: '0',
  schemaRequired: false,
  // MULTI/EXEC queues commands; it cannot undo one that ran. The adapter opens
  // nothing, so every command is final as it runs.
  transactions: false,

  buildConnectionString(option: ConnectionOptions): string {
    if (option.connectionString?.trim()) return option.connectionString.trim();

    const host = option.host || 'localhost';
    const port = option.port || this.defaultPort;
    // rediss:// is the TLS scheme; the driver picks its transport from it.
    const scheme = option.ssl?.enabled ? 'rediss' : 'redis';

    // Redis auth is either a bare password (legacy AUTH) or user+password
    // (ACLs, Redis 6+). Both belong in the userinfo section, and an empty
    // username with a password is the legacy form spelled correctly.
    const username = encodeURIComponent(option.username || '');
    const password = encodeURIComponent(option.password || '');
    const auth = password || username ? `${username}:${password}@` : '';

    // The database goes in the path. Only a plain integer is meaningful —
    // anything else would silently select nothing.
    const db = String(option.schema ?? '').trim();
    const path = /^\d+$/.test(db) ? `/${db}` : '';

    return `${scheme}://${auth}${host}:${port}${path}`;
  },
};
