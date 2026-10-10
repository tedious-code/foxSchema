/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The data-migrate feature: moving rows between databases, and its run history.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createDataMigrateRoutes } from './data-migrate.routes';
import { DataMigrateHistoryStore } from './data-migrate-history.service';

export const dataMigrateFeature: ServerFeatureModule = {
  id: 'data-migrate',
  mounts: [
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) =>
        createDataMigrateRoutes({ resolveRef: ctx.resolver.resolveRef, dataMigrateHistory: new DataMigrateHistoryStore() }),
    },
  ],
};
