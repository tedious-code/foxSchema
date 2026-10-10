import type { FastifyReply } from 'fastify';
import { scopeOf } from '../../platform/http/scope';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { ConnectionStore } from '../../platform/connections/connection-store.service';
import { pruneOrphanFileQueryConnections } from '../files';
import type { AuthedRequest } from '../../platform/http/types';
import { sendError, sendThrown } from '../../platform/http/respond';

/** CRUD for the signed-in user's saved connections (credentials encrypted at rest). */
export function createConnectionStoreRoutes(store: ConnectionStore): Router {
  const router = Router();

  router.get('/', async (req: AuthedRequest, res: FastifyReply) => {
    // Drop stale Query-files workspaces whose temp DB expired — keeps upgrades
    // and long-running sessions free of dead `Files:` credentials.
    await pruneOrphanFileQueryConnections(store, scopeOf(req)!).catch(() => undefined);
    res.send({ connections: await store.list(scopeOf(req)!) });
  });

  router.post('/', async (req: AuthedRequest, res: FastifyReply) => {
    const { name, dialect, schema, option, savePassword } = req.body as {
      name?: string;
      dialect?: string;
      schema?: string;
      option?: Record<string, unknown>;
      savePassword?: boolean;
    };
    if (!dialect || !option) {
      sendError(res, 'invalid_input', 'dialect and option are required');
      return;
    }
    try {
      res.send({ connection: await store.create(scopeOf(req)!, { name, dialect, schema, option, savePassword }) });
    } catch (error: unknown) {
      sendThrown(res, error, 'Failed to save connection');
    }
  });

  router.put('/:id', async (req: AuthedRequest, res: FastifyReply) => {
    const { name, dialect, schema, option, savePassword } = req.body as {
      name?: string;
      dialect?: string;
      schema?: string;
      option?: Record<string, unknown>;
      savePassword?: boolean;
    };
    if (!dialect || !option) {
      sendError(res, 'invalid_input', 'dialect and option are required');
      return;
    }
    try {
      const updated = await store.update(scopeOf(req)!, String(req.params.id), { name, dialect, schema, option, savePassword });
      if (!updated) {
        sendError(res, 'not_found', 'Connection not found');
        return;
      }
      res.send({ connection: updated });
    } catch (error: unknown) {
      sendThrown(res, error, 'Failed to update connection');
    }
  });

  router.delete('/:id', async (req: AuthedRequest, res: FastifyReply) => {
    const removed = await store.remove(scopeOf(req)!, String(req.params.id));
    if (!removed) {
      sendError(res, 'not_found', 'Saved connection not found');
      return;
    }
    res.send({ ok: true });
  });

  return router;
}
