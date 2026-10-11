/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The files feature: uploads, querying an uploaded file as SQLite, imports and
 * their worker pool, and the database-file picker.
 */
import type { ServerFeatureModule } from '../../platform/feature-module';
import { getLogger } from '../../platform/logger/logger';
import { createFileQueryRoutes } from './files.routes';
import { createFileBrowseRoutes } from './file-browse.routes';
import { sweepOrphanedUploadFiles } from './file-session.service';

export { pruneOrphanFileQueryConnections } from './file-query.service';

export const filesFeature: ServerFeatureModule = {
  id: 'files',
  mounts: [
    { prefix: '/api/files', access: 'user', routes: (ctx) => createFileQueryRoutes(ctx.connectionStore) },
    { prefix: '/api', access: 'user', rateLimited: true, routes: () => createFileBrowseRoutes() },
  ],
  // Partial uploads are tracked in memory, so a `.part` file on disk at
  // startup belongs to no live session.
  onBoot: () => {
    const swept = sweepOrphanedUploadFiles();
    if (swept > 0) getLogger().info({ component: 'uploads', removed: swept }, 'swept orphaned upload parts');
  },
};
