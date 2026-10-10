/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The system feature: liveness, version and updates, app info, activity.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createSystemPublicRoutes, createSystemRoutes } from './system.routes';

export const systemFeature: ServerFeatureModule = {
  id: 'system',
  mounts: [
    { prefix: '/api', access: 'public', routes: () => createSystemPublicRoutes() },
    { prefix: '/api', access: 'user', rateLimited: true, routes: () => createSystemRoutes() },
  ],
};
