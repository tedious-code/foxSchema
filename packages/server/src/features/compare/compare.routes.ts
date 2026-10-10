/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Declaration only: path, method, guards. No logic.
 */
import { Router } from '../../platform/http/router';
import { requirePermissions } from '../../platform/authorization/rbac.guard';
import { makeCompareController } from './compare.controller';
import { makeCompareHandlers } from './compare.handler';
import type { CompareService } from './compare.service';

export function createCompareRoutes(deps: { compareService: CompareService }): Router {
  const router = Router();
  const handlers = makeCompareHandlers(makeCompareController(deps));

  router.post('/compare', requirePermissions('schema.compare'), handlers.compare);

  return router;
}
