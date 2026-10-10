/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The users feature: profile and preferences, and the first-open signup wizard.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createSignupRoutes } from './signup-wizard.routes';
import { createUserRoutes } from './user.routes';
import { UserModule } from './user.service';

export { SignupModule } from './signup-wizard.service';

export const usersFeature: ServerFeatureModule = {
  id: 'users',
  mounts: [
    // Public: the wizard shows before anyone has signed in.
    { prefix: '/api/signup', access: 'public', routes: () => createSignupRoutes() },
    { prefix: '/api/user', access: 'user', routes: () => createUserRoutes(new UserModule()) },
  ],
};
