/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The admin feature: users and roles, secrets and cloud credentials, policy.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createAdminRoutes } from './admin.routes';
import { createAppSecretsRoutes } from './app-secrets.routes';
import { AppSecretsStore } from './app-secrets.service';

export const adminFeature: ServerFeatureModule = {
  id: 'admin',
  mounts: [
    { prefix: '/api/app-secrets', access: 'user', routes: () => createAppSecretsRoutes(new AppSecretsStore()) },
    { prefix: '/api/admin', access: 'registered', routes: () => createAdminRoutes() },
  ],
};
