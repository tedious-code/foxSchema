import type { FastifyReply } from 'fastify';
import { scopeOf } from '../../platform/http/scope';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { AppSecretsStore, type AppSecretInput } from './app-secrets.service';
import {
  CloudProviderCredentialsStore,
  type CloudProviderCredentials,
} from './cloud-provider-credentials.service';
import type { CloudSecretRef } from '../../internal/cloud-secrets';
import { isCloudSecretSource } from '../../internal/cloud-secrets';
import type { AuthedRequest } from '../../platform/http/types';
import { requirePermissions } from '../../platform/authorization/rbac.guard';
import { sendError, sendThrown } from '../../platform/http/respond';

function parseSecretBody(body: unknown): Partial<AppSecretInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const cloudRaw = b.cloudRef as Partial<CloudSecretRef> | undefined;
  const cloudRef: CloudSecretRef | undefined =
    cloudRaw && typeof cloudRaw.secretId === 'string'
      ? {
          secretId: cloudRaw.secretId,
          credentialId:
            typeof cloudRaw.credentialId === 'string' ? cloudRaw.credentialId : undefined,
          region: typeof cloudRaw.region === 'string' ? cloudRaw.region : undefined,
          vaultUrl: typeof cloudRaw.vaultUrl === 'string' ? cloudRaw.vaultUrl : undefined,
          version: typeof cloudRaw.version === 'string' ? cloudRaw.version : undefined,
        }
      : undefined;
  return {
    name: typeof b.name === 'string' ? b.name : undefined,
    source:
      b.source === 'local' || b.source === 'aws' || b.source === 'gcp' || b.source === 'azure'
        ? b.source
        : undefined,
    value: typeof b.value === 'string' ? b.value : undefined,
    cloudRef,
  };
}

/** CRUD + resolve for the signed-in user's App Secrets vault + named cloud credentials. */
export function createAppSecretsRoutes(
  store: AppSecretsStore,
  providers = new CloudProviderCredentialsStore()
): Router {
  const router = Router();

  router.get('/', requirePermissions('secrets.view'), async (req: AuthedRequest, res: FastifyReply) => {
    res.send({ secrets: await store.list(scopeOf(req)!) });
  });

  router.get('/providers', requirePermissions('secrets.view'), async (req: AuthedRequest, res: FastifyReply) => {
    res.send({ providers: await providers.list(scopeOf(req)!) });
  });

  router.post('/providers', requirePermissions('secrets.create'), async (req: AuthedRequest, res: FastifyReply) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      provider?: unknown;
      credentials?: CloudProviderCredentials;
    };
    const name = typeof body.name === 'string' ? body.name : '';
    const providerRaw = typeof body.provider === 'string' ? body.provider : '';
    if (!isCloudSecretSource(providerRaw)) {
      sendError(res, 'invalid_input', 'provider must be aws, gcp, or azure');
      return;
    }
    if (!body.credentials || typeof body.credentials !== 'object') {
      sendError(res, 'invalid_input', 'credentials object is required');
      return;
    }
    try {
      res.send({
        provider: await providers.create(scopeOf(req)!, name, providerRaw, body.credentials),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to save provider credentials';
      const status = /require|Invalid|must be|already exists|Unknown/i.test(msg) ? 400 : 500;
      res.status(status).send({ error: msg });
    }
  });

  router.put('/providers/:id', requirePermissions('secrets.edit'), async (req: AuthedRequest, res: FastifyReply) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      credentials?: CloudProviderCredentials;
    };
    try {
      const updated = await providers.update(scopeOf(req)!, String(req.params.id), {
        name: typeof body.name === 'string' ? body.name : undefined,
        credentials:
          body.credentials && typeof body.credentials === 'object' ? body.credentials : undefined,
      });
      if (!updated) {
        sendError(res, 'not_found', 'Cloud credential not found');
        return;
      }
      res.send({ provider: updated });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update provider credentials';
      const status = /require|Invalid|must be|already exists/i.test(msg) ? 400 : 500;
      res.status(status).send({ error: msg });
    }
  });

  router.delete('/providers/:id', requirePermissions('secrets.delete'), async (req: AuthedRequest, res: FastifyReply) => {
    const removed = await providers.remove(scopeOf(req)!, String(req.params.id));
    if (!removed) {
      sendError(res, 'not_found', 'Secret not found');
      return;
    }
    res.send({ ok: true });
  });

  router.post('/', requirePermissions('secrets.create'), async (req: AuthedRequest, res: FastifyReply) => {
    const input = parseSecretBody(req.body);
    if (!input.name || !input.source) {
      sendError(res, 'invalid_input', 'name and source are required');
      return;
    }
    try {
      res.send({
        secret: await store.create(scopeOf(req)!, {
          name: input.name,
          source: input.source,
          value: input.value,
          cloudRef: input.cloudRef,
        }),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to create secret';
      const status = /already exists|Invalid|require/i.test(msg) ? 400 : 500;
      res.status(status).send({ error: msg });
    }
  });

  router.post('/resolve', requirePermissions('secrets.view'), async (req: AuthedRequest, res: FastifyReply) => {
    const names = Array.isArray((req.body as { names?: unknown })?.names)
      ? ((req.body as { names: unknown[] }).names.filter((n) => typeof n === 'string') as string[])
      : undefined;
    try {
      const out = await store.resolve(scopeOf(req)!, names);
      res.send(out);
    } catch (error: unknown) {
      sendThrown(res, error, 'Failed to resolve secrets');
    }
  });

  router.put('/:id', requirePermissions('secrets.edit'), async (req: AuthedRequest, res: FastifyReply) => {
    const input = parseSecretBody(req.body);
    try {
      const updated = await store.update(scopeOf(req)!, String(req.params.id), input);
      if (!updated) {
        sendError(res, 'not_found', 'Secret not found');
        return;
      }
      res.send({ secret: updated });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update secret';
      const status = /already exists|Invalid|require/i.test(msg) ? 400 : 500;
      res.status(status).send({ error: msg });
    }
  });

  router.delete('/:id', requirePermissions('secrets.delete'), async (req: AuthedRequest, res: FastifyReply) => {
    const removed = await store.remove(scopeOf(req)!, String(req.params.id));
    if (!removed) {
      sendError(res, 'not_found', 'Secret not found');
      return;
    }
    res.send({ ok: true });
  });

  return router;
}
