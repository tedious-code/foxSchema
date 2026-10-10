/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 * The files feature: uploads, querying an uploaded file as SQLite, imports and
 * their worker pool, and the database-file picker.
 */
import type { ServerFeatureModule } from '../../app/feature-module';
import { createFileQueryRoutes } from './files.routes';
import { createFileBrowseRoutes } from './file-browse.routes';

export { pruneOrphanFileQueryConnections } from './file-query.service';
export { sweepOrphanedUploadFiles } from './file-session.service';

export const filesFeature: ServerFeatureModule = {
  id: 'files',
  mounts: [
    { prefix: '/api/files', access: 'user', routes: (ctx) => createFileQueryRoutes(ctx.connectionStore) },
    { prefix: '/api', access: 'user', rateLimited: true, routes: () => createFileBrowseRoutes() },
  ],
};
