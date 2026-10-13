/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The guard on every `internal` mount: the routes only the workflow engine
 * calls. They sit outside the user session — the engine runs on a schedule
 * with nobody signed in — so it presents the service token both processes
 * share instead. Applied by the feature registry to the whole mount, so a
 * route added there cannot forget it.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { WORKFLOW_ENGINE_TOKEN_ENV } from '@foxschema/workflow-contract';
import { sendError } from '../http/respond';
import type { AppRequest, NextFunction } from '../http/types';

/**
 * Accept only a request that presents the shared token.
 *
 * With no token configured the routes answer 503 rather than opening up: an
 * install that has not set one has not decided to let the engine reach saved
 * connections.
 */
export function engineTokenGuard(token: string | undefined = process.env[WORKFLOW_ENGINE_TOKEN_ENV]) {
  const expected = token ? Buffer.from(token) : undefined;
  return (req: AppRequest, res: FastifyReply, next: NextFunction): void => {
    if (!expected) {
      sendError(res, 'unavailable', `${WORKFLOW_ENGINE_TOKEN_ENV} is not set, so the workflow engine cannot use saved connections`);
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '');
    // Compared in constant time; the length check first is required by
    // timingSafeEqual and reveals only the length, which is not the secret.
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      sendError(res, 'unauthenticated', 'Invalid workflow engine token');
      return;
    }
    next();
  };
}
