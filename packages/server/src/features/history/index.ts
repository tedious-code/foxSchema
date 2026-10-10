/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The history feature: schema versions (Lokee Weave), revert and force-migrate.
 */
import { MigrationModule } from '@foxschema/db';
import type { FeatureContext, ServerFeatureModule } from '../../app/feature-module';
import { gitServices } from '../git';
import { createHistoryRoutes } from './history.routes';
import { LokeeWeaveStore } from './lokee-weave.service';
import { makeCaptureLiveSchema, type CaptureLiveSchema } from './live-capture.service';

export type { CaptureLiveSchema } from './live-capture.service';

const runtimes = new WeakMap<FeatureContext, { lokee: LokeeWeaveStore; captureLiveSchema: CaptureLiveSchema }>();

/**
 * One history store per app: migrate and revert both capture through it,
 * and its per-database lock only works if they share it.
 */
export function historyRuntime(ctx: FeatureContext): { lokee: LokeeWeaveStore; captureLiveSchema: CaptureLiveSchema } {
  let runtime = runtimes.get(ctx);
  if (!runtime) {
    const lokee = new LokeeWeaveStore();
    runtime = { lokee, captureLiveSchema: makeCaptureLiveSchema(lokee, ctx.resolver.loadScopedTables) };
    runtimes.set(ctx, runtime);
  }
  return runtime;
}

export const historyFeature: ServerFeatureModule = {
  id: 'history',
  mounts: [
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) =>
        createHistoryRoutes({
          lokee: historyRuntime(ctx).lokee,
          captureLiveSchema: historyRuntime(ctx).captureLiveSchema,
          resolveRef: ctx.resolver.resolveRef,
          migrationModule: new MigrationModule(),
          loadScopedTables: ctx.resolver.loadScopedTables,
          commitRequired: () => gitServices().migrations.commitRequired(),
        }),
    },
  ],
};
