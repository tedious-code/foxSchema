/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every server feature, and the one place they are composed into the API.
 *
 * Installing a feature is adding its module to FEATURES. Nothing registers
 * itself on import, and no feature attaches the session guard or the API
 * rate limit by hand: `composeFeatures` derives them from each mount's
 * `access` and `rateLimited`.
 *
 * Mount order: public mounts first (sign-in must not sit behind the
 * session guard), then the engine's internal routes, then signed-in
 * mounts, then the rate-limited `/api` group — the order the route tree
 * always had. Within each group, registry order.
 */
import { ConnectionModule } from '@foxschema/db';
import { Router } from '../platform/http/router';
import type { Middleware } from '../platform/http/types';
import { authGuard, requireRegisteredAccount } from '../platform/identity/auth.guard';
import { AuthModule } from '../platform/identity/auth.service';
import { ConnectionStore } from '../platform/connections/connection-store.service';
import { makeConnectionResolver } from '../platform/connections/resolve';
import { defaultApiRateLimit } from '../platform/guards/rate-limit';
import type { FeatureContext, FeatureMount, ServerFeatureModule } from './feature-module';
import { systemFeature } from '../features/system';
import { authFeature } from '../features/auth';
import { usersFeature } from '../features/users';
import { workflowFeature } from '../features/workflow';
import { connectionsFeature } from '../features/connections';
import { adminFeature } from '../features/admin';
import { workspacesFeature } from '../features/workspaces';
import { backupFeature } from '../features/backup';
import { gitFeature } from '../features/git';
import { filesFeature } from '../features/files';
import { compareFeature } from '../features/compare';
import { accessFeature } from '../features/access';
import { schemaFeature } from '../features/schema';
import { dataMigrateFeature } from '../features/data-migrate';
import { migrationFeature } from '../features/migration';
import { sqlEditorFeature } from '../features/sql-editor';
import { historyFeature } from '../features/history';

export const FEATURES: readonly ServerFeatureModule[] = [
  systemFeature,
  authFeature,
  usersFeature,
  workflowFeature,
  connectionsFeature,
  adminFeature,
  workspacesFeature,
  backupFeature,
  gitFeature,
  filesFeature,
  compareFeature,
  accessFeature,
  schemaFeature,
  dataMigrateFeature,
  migrationFeature,
  sqlEditorFeature,
  historyFeature,
];

/** The shared instances features receive: one of each per process. */
export function createFeatureContext(): FeatureContext {
  const connectionModule = new ConnectionModule();
  const connectionStore = new ConnectionStore();
  return {
    auth: new AuthModule(),
    connectionModule,
    connectionStore,
    resolver: makeConnectionResolver(connectionModule, connectionStore),
  };
}

function phase(mount: FeatureMount): number {
  if (mount.access === 'public') return 0;
  if (mount.access === 'internal') return 1;
  return mount.rateLimited ? 3 : 2;
}

/** The route tree for `features`, with each mount's guards applied. */
export function composeFeatures(features: readonly ServerFeatureModule[], context: FeatureContext): Router {
  const seen = new Set<string>();
  for (const feature of features) {
    if (seen.has(feature.id)) throw new Error(`Feature "${feature.id}" is registered twice.`);
    seen.add(feature.id);
  }

  const session = authGuard(context.auth);
  const registeredOnly = requireRegisteredAccount();
  // One limiter for the whole group: a caller's budget is shared across features.
  const apiLimit = defaultApiRateLimit();

  const guardsFor = (mount: FeatureMount): Middleware[] => {
    if (mount.access === 'public' || mount.access === 'internal') {
      if (mount.rateLimited) throw new Error(`${mount.prefix}: the API rate limit counts per signed-in caller; public mounts set their own limits.`);
      return [];
    }
    const guards: Middleware[] = [session];
    if (mount.access === 'registered') guards.push(registeredOnly);
    if (mount.rateLimited) guards.push(apiLimit);
    return guards;
  };

  const mounts = features
    .flatMap((feature) => feature.mounts)
    .map((mount, index) => ({ mount, index }))
    .sort((a, b) => phase(a.mount) - phase(b.mount) || a.index - b.index);

  const root = Router();
  for (const { mount } of mounts) {
    root.use(mount.prefix, ...guardsFor(mount), mount.routes(context));
  }
  return root;
}
