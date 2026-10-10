/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The schema feature: reading a schema, table insight, DBA probes.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createSchemaRoutes } from './schema.routes';

export { probeTableInsight } from './table-insight.service';

export const schemaFeature: ServerFeatureModule = {
  id: 'schema',
  mounts: [
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) =>
        createSchemaRoutes({
          resolveRef: ctx.resolver.resolveRef,
          connectionModule: ctx.connectionModule,
          loadScopedTables: ctx.resolver.loadScopedTables,
        }),
    },
  ],
};
