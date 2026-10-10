/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The server-side file picker for SQLite / DuckDB database files.
 */
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { rateLimit } from '../../platform/guards/rate-limit';
import { requirePermissions } from '../../platform/authorization/rbac.guard';
import { sendError } from '../../platform/http/respond';
import { browseDirectory, browseErrorMessage, resolveBrowsePath } from './file-browse';

export function createFileBrowseRoutes(): Router {
  const router = Router();

  // Directory listing for the SQLite / DuckDB file picker. Read-only and
  // name-only: it never returns file contents, and only names files a database
  // driver could open. `schema.browse` because picking a database file is the
  // first step of browsing one.
  const fileBrowseLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

  router.get(
    '/files/browse',
    fileBrowseLimiter,
    requirePermissions('schema.browse'),
    async (req: AppRequest, res: FastifyReply) => {
      const requested = typeof req.query.path === 'string' ? req.query.path : undefined;
      try {
        res.send(await browseDirectory(requested));
      } catch (error: unknown) {
        // The path is echoed back resolved, so the message names the directory
        // the server actually tried rather than the raw query string.
        sendError(res, 'invalid_input', browseErrorMessage(error, resolveBrowsePath(requested)));
      }
    }
  );

  return router;
}
