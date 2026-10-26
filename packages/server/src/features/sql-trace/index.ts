/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SQL Tracer: watch the statements running on a saved connection (the
 * engine's own session list) or the ones Fox runs on it, for a bounded time.
 */
import type { ConnectionOptions } from '@foxschema/db';
import type { ServerFeatureModule } from '../../platform/feature-module';
import { probeDbaUtility } from '../access';
import { createSqlTraceRoutes } from './sql-trace.routes';
import { SqlTraceService, type ProbeSessions } from './sql-trace.service';

const probeSessions: ProbeSessions = async ({ dialect, option }) => {
  const probed = await probeDbaUtility({ dialect, option: option as ConnectionOptions, kind: 'sessions' });
  if (!probed.ok) return { ok: false, error: probed.failure.error };
  return { ok: true, sessions: probed.value.sessions ?? [] };
};

export const sqlTraceFeature: ServerFeatureModule = {
  id: 'sql-trace',
  mounts: [
    {
      prefix: '/api/sql-trace',
      access: 'registered',
      rateLimited: true,
      routes: (ctx) =>
        createSqlTraceRoutes({
          service: new SqlTraceService({ activity: ctx.sqlActivity, probeSessions }),
          resolveRef: ctx.resolver.resolveRef,
        }),
    },
  ],
};
