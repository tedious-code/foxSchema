/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The connections feature: the saved-connection API, driver checks and installs,
 * and connection tests. The store itself is platform/connections.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createConnectionStoreRoutes } from './connections.routes';
import { createConnectionToolRoutes } from './connection-tools.routes';

export const connectionsFeature: ServerFeatureModule = {
  id: 'connections',
  mounts: [
    { prefix: '/api/connections', access: 'user', routes: (ctx) => createConnectionStoreRoutes(ctx.connectionStore) },
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) => createConnectionToolRoutes({ connectionModule: ctx.connectionModule, resolveRef: ctx.resolver.resolveRef }),
    },
  ],
};
