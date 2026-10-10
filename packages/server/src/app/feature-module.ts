/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a server feature declares so the app can mount it: an id, and where
 * its routes go with which access level. Everything else — the session
 * guard, the shared rate limit, mount order — the registry applies, so no
 * feature wires them itself and none can forget them.
 *
 * Guide: docs/architecture/FEATURE-MODULE-GUIDE.md
 */
import type { ConnectionModule } from '@foxschema/db';
import type { Router } from '../platform/http/router';
import type { AuthModule } from '../platform/identity/auth.service';
import type { ConnectionStore } from '../platform/connections/connection-store.service';
import type { ConnectionResolver } from '../platform/connections/resolve';

/**
 * Who may reach a mount, before any per-route permission check:
 *
 * - `public`: anyone (sign-in, setup, health).
 * - `internal`: no session; the routes check the workflow engine's service token.
 * - `user`: a signed-in session (a launch session included).
 * - `registered`: a signed-in account — never a launch link.
 */
export type FeatureAccess = 'public' | 'internal' | 'user' | 'registered';

export interface FeatureMount {
  /** Absolute path prefix, e.g. `/api/backup-settings`. */
  prefix: string;
  access: FeatureAccess;
  /**
   * Behind the API-wide rate limit as well. One limiter serves every mount
   * that sets this, so it is a single budget per caller, not one per feature.
   */
  rateLimited?: boolean;
  routes: (context: FeatureContext) => Router;
}

export interface ServerFeatureModule {
  /** Stable, kebab-case; matches the feature folder name. */
  id: string;
  mounts: FeatureMount[];
}

/**
 * What the platform hands every feature: shared instances that must be one
 * per process. Typed and small on purpose — not a service locator.
 */
export interface FeatureContext {
  readonly auth: AuthModule;
  readonly connectionModule: ConnectionModule;
  readonly connectionStore: ConnectionStore;
  readonly resolver: ConnectionResolver;
}
