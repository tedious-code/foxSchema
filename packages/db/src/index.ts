/**
 * @foxschema/db — the Node runtime: drivers, pooling, and migration execution.
 *
 * Everything dialect-shaped (SQL generation, compare, splitting, type mapping)
 * lives in @foxschema/sql, which is pure and browser-safe. This package is the
 * half that needs sockets and native drivers, and it re-exports the pure half
 * so a Node consumer still has one import to reach for.
 *
 * If you are writing browser or otherwise runtime-neutral code, depend on
 * @foxschema/sql directly — importing this package drags in the driver layer.
 */

// The pure half, re-exported wholesale so backend code keeps one import.
export * from '@foxschema/sql';

// Runtime (Node-only)
export { ConnectionModule } from './modules/connection.module.js';
export { MigrationModule } from './modules/migration.module.js';
export {
  dialectSupportsTransactionalRollback,
  dialectSupportsTransactionalDdlRollback,
} from './modules/dialect-transaction-support.js';
export { ConnectionFactory } from './cores/connection-factory.js';
// The library front door: one handle that queries and closes itself. See
// cores/open-database.ts for why this sits alongside the factory rather than
// replacing it.
export { openDatabase, queryOnce, type OpenDatabase } from './cores/open-database.js';
export { DriverDetector, readInstalledPackageVersion } from './cores/driver-detector.js';
export { driverLoadReason, driverRequire, redactInstallPaths, requireDriver } from './cores/driver-loader.js';
export { assertSafeIdentifier } from './cores/sql-identifier.js';
export {
  assertSafeEmbeddedDatabasePath,
  isProtectedEmbeddedDatabasePath,
} from './cores/embedded-db-guard.js';
export {
  BoundedPoolCache,
  disposePoolEndOrClose,
  nonSecretFingerprint,
  credentialedCacheKey,
} from './cores/pool-cache.js';

// Provider/adapter registries
export { getAdapter, ADAPTERS } from './providers/adapter-registry.js';
export { getRegisteredProvider, PROVIDERS } from './providers/provider-registry.js';
// Add-on dialects (Db2 lives in @foxschema/db-db2).
export {
  registerDialectPlugin,
  dialectPlugin,
  loadDialectPlugin,
  ensureDialect,
  resetDialectPluginsForTest,
  type DialectPlugin,
  type DriverProblem,
} from './plugins/dialect-plugin.js';
export { addonPackageFor, missingAddonMessage } from './plugins/addon-packages.js';
export {
  noopLogger,
  safeTarget,
  type AppLogger,
  type DbLogFields,
} from './cores/logger.js';
