/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The git feature: the repositories migrations are committed to.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createGitRoutes } from './git.routes';

export { gitServices, type GitMigrationsService } from './git-migrations.service';

export const gitFeature: ServerFeatureModule = {
  id: 'git',
  mounts: [{ prefix: '/api/git', access: 'user', routes: (ctx) => createGitRoutes(ctx.resolver.resolveRef) }],
};
