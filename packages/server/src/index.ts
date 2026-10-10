/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The public surface of the server package.
 *
 * Consumers are the CLI and the web app's serve entry. Everything not exported
 * here is internal, so the package can be reorganised without breaking them.
 *
 * The package has a single entry point (`.` in package.json) rather than
 * several deep subpaths, so module resolution is configured in one place.
 *
 * Adding an export makes it part of the package's contract, so add
 * deliberately.
 */

/** Running the whole thing: single-origin UI + API. */
export { startUiServer, serverFlavour } from './startUiServer';
export type { StartUiServerOptions, StartedUiServer } from './startUiServer';
export { DEFAULT_API_PORT } from './defaultApiPort';

/** The HTTP app itself, for tests and for embedding. */
export { buildApiRoutes, startServer } from './api/server';
export { createFastifyApp } from './api/fastify-server';

/** Metadata store access, for callers that talk to the database directly. */
export { getStore } from './database/store';

/** Feature services the CLI drives without going through HTTP. */
export { AuthModule } from './features/auth/auth.service';
export { ConnectionStore } from './features/connections/connection-store.service';
export type { WorkspaceScope } from './platform/http/scope';
export type { SavedConnectionSummary } from './features/connections/connection-store.service';
export { MigrationHistoryStore } from './features/migration/migration-history.service';
export type {
  MigrationRunDetail,
  MigrationRunSummary,
  MigrationObjectResult,
  MigrationRunStatus,
} from './features/migration/migration-history.service';
export { AppSettingsStore } from './features/admin/app-settings.service';

/** Logging, so a host process writes into the same stream as the server. */
export { getLogger } from './platform/logger/logger';

/** The error contract, re-exported so consumers need one import. */
export { ServiceError, toApiError, toHttpError } from './platform/contracts/actor';
export type { ActorContext } from './platform/contracts/actor';
