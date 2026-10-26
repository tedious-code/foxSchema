/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The access feature: database principals, privileges, permission diff and reports.
 */
import type { ServerFeatureModule } from '../../platform/feature-module';
import { createAccessRoutes } from './access.routes';

export const accessFeature: ServerFeatureModule = {
  id: 'access',
  mounts: [
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) => createAccessRoutes({ resolveRef: ctx.resolver.resolveRef, connectionModule: ctx.connectionModule }),
    },
  ],
};

/** The engine's own probes (sessions, pool, system, sizes); the SQL Tracer polls the sessions one. */
export { probeDbaUtility } from './dba-utilities.service';
