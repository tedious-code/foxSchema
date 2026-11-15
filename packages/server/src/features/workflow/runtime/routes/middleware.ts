/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/routes/middleware.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/** Registered control-plane middleware — powers the designer's picker. */
export function middlewareRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get('/middleware', async () => ({
      middleware: ctx.middleware.list(),
    }));
  };
}
