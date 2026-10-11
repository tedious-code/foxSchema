/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The history feature: schema versions (Lokee Weave), revert and force-migrate.
 */
import { MigrationModule } from '@foxschema/db';
import type { FeatureContext, ServerFeatureModule } from '../../platform/feature-module';
import { gitServices } from '../git';
import { createHistoryRoutes } from './history.routes';
import { LokeeWeaveStore } from './lokee-weave.service';
import { makeCaptureLiveSchema, type CaptureLiveSchema } from './live-capture.service';

export type { CaptureLiveSchema } from './live-capture.service';

/**
 * Captures a database's live schema as a history version. Migrate captures
 * before and after it runs, so the migration feature takes this as well.
 */
export function captureLiveSchemaFor(ctx: FeatureContext, lokee = new LokeeWeaveStore()): CaptureLiveSchema {
  return makeCaptureLiveSchema(lokee, ctx.resolver.loadScopedTables);
}

export const historyFeature: ServerFeatureModule = {
  id: 'history',
  mounts: [
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) => {
        const lokee = new LokeeWeaveStore();
        return createHistoryRoutes({
          lokee,
          captureLiveSchema: captureLiveSchemaFor(ctx, lokee),
          resolveRef: ctx.resolver.resolveRef,
          migrationModule: new MigrationModule(),
          loadScopedTables: ctx.resolver.loadScopedTables,
          commitRequired: () => gitServices().migrations.commitRequired(),
        });
      },
    },
  ],
};
