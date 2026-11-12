/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The auth feature: sign-in, setup, password and SSO routes, and the sign-in
 * settings screen. The services behind them are platform/identity.
 */
import type { ServerFeatureModule } from '../../platform/feature-module';
import { createAuthRoutes } from './auth.routes';
import { createSsoRoutes } from './sso.routes';
import { createSignInSettingsRoutes } from './sign-in-settings.routes';
// The one place auth reaches into the secrets feature: Google sign-in can
// save a Google Cloud connection when an admin turns that on.
import { GcpOAuthService } from '../admin';

export const authFeature: ServerFeatureModule = {
  id: 'auth',
  mounts: [
    // SSO before the base auth router, so its sub-paths are declared first.
    {
      prefix: '/api/auth/sso',
      access: 'public',
      routes: (ctx) => {
        const gcp = new GcpOAuthService();
        return createSsoRoutes(ctx.auth, undefined, undefined, async (user, grant) => {
          const workspaceId = await ctx.auth.personalWorkspaceId(user);
          await gcp.connectAtSignIn({ userId: user.id, workspaceId }, grant);
        });
      },
    },
    { prefix: '/api/auth', access: 'public', routes: (ctx) => createAuthRoutes(ctx.auth) },
    { prefix: '/api/admin/sign-in', access: 'registered', routes: () => createSignInSettingsRoutes() },
  ],
};
