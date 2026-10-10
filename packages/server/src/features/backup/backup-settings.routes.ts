/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The signed-in user's backup defaults, per engine. Reading and saving them is
 * every user's own business, so no permission beyond being signed in.
 */
import type { FastifyReply } from 'fastify';
import { Router } from '../../platform/http/router';
import { sendError } from '../../platform/http/respond';
import type { AuthedRequest } from '../../platform/http/types';
import { BackupSettingsModule, UnknownBackupDialect } from './backup-settings.service';

export function createBackupSettingsRoutes(module: BackupSettingsModule = new BackupSettingsModule()): Router {
  const router = Router();

  router.get('/', async (req: AuthedRequest, res: FastifyReply) => {
    res.send({ settings: await module.list(req.userId!) });
  });

  router.put('/:dialect', async (req: AuthedRequest, res: FastifyReply) => {
    const { dialect } = req.params as { dialect: string };
    try {
      res.send({ settings: await module.save(req.userId!, dialect, req.body) });
    } catch (err) {
      if (err instanceof UnknownBackupDialect) {
        sendError(res, 'invalid_input', err.message);
        return;
      }
      throw err;
    }
  });

  return router;
}
