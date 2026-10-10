/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The compare feature: comparing two schemas.
 */
import { CompareModule } from '@foxschema/db';
import type { ServerFeatureModule } from '../../app/feature-module';
import { createCompareRoutes } from './compare.routes';
import { makeCompareService } from './compare.service';

export const compareFeature: ServerFeatureModule = {
  id: 'compare',
  mounts: [
    {
      prefix: '/api',
      access: 'user',
      rateLimited: true,
      routes: (ctx) =>
        createCompareRoutes({ compareService: makeCompareService({ resolver: ctx.resolver, compareModule: new CompareModule() }) }),
    },
  ],
};
