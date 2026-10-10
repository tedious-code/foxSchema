/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The migration feature: applying a migration, and its run history.
 */
import { MigrationModule, SqlGeneratorModule, normalizeTableSchemas } from '@foxschema/db';
import type { ServerFeatureModule } from '../../app/feature-module';
import { historyRuntime } from '../history';
import { createMigrationRoutes } from './migration.routes';
import { MigrationHistoryStore } from './migration-history.service';

export const migrationFeature: ServerFeatureModule = {
  id: 'migration',
  mounts: [
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) =>
        createMigrationRoutes({
          resolveRef: ctx.resolver.resolveRef,
          migrationModule: new MigrationModule(),
          migrationHistory: new MigrationHistoryStore(),
          connectionModule: ctx.connectionModule,
          sqlGenerator: new SqlGeneratorModule(),
          captureLiveSchema: historyRuntime(ctx).captureLiveSchema,
          normalizeTableSchemas,
        }),
    },
  ],
};
