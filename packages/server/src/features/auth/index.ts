/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The auth feature: sign-in, setup, password and SSO routes, and the sign-in
 * settings screen. The services behind them are platform/identity.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createAuthRoutes } from './auth.routes';
import { createSsoRoutes } from './sso.routes';
import { createSignInSettingsRoutes } from './sign-in-settings.routes';

export const authFeature: ServerFeatureModule = {
  id: 'auth',
  mounts: [
    // SSO before the base auth router, so its sub-paths are declared first.
    { prefix: '/api/auth/sso', access: 'public', routes: (ctx) => createSsoRoutes(ctx.auth) },
    { prefix: '/api/auth', access: 'public', routes: (ctx) => createAuthRoutes(ctx.auth) },
    { prefix: '/api/admin/sign-in', access: 'registered', routes: () => createSignInSettingsRoutes() },
  ],
};
