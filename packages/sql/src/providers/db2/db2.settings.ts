import { type ConnectionOptions, type ProviderConnectionSettings } from '../../interfaces/schema-provider.interface.js';
import { buildDb2ConnectionString } from './db2.connection.js';

/**
 * The ibm_db release Fox installs and tells people to install.
 *
 * Pinned exactly: ibm_db downloads IBM's clidriver at install time and builds a
 * native binding, and a floating range has broken that before. The package.json
 * entries (packages/db, apps/web) must match — `ibm-db-pin.test.ts` checks.
 * Changing the version means changing it here and there, nowhere else.
 */
export const IBM_DB_VERSION = '4.1.0';

export const db2Settings: ProviderConnectionSettings = {
  dialect: 'db2',
  label: 'IBM DB2',
  defaultPort: 50000,
  schemaRequired: true,

  // Single source of truth for the DB2 format: ibm_db only accepts the
  // keyword=value; form (never a URL), so this also parses+normalizes any
  // existing connection string the caller passes in.
  buildConnectionString(option: ConnectionOptions): string {
    return buildDb2ConnectionString(option, option.schema);
  },
};
