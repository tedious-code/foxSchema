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
import { SignInSettings } from '../../platform/identity/sign-in-settings.service';
import {
  GcpOAuthService,
  readGcpOAuthStateCookie,
} from './gcp-oauth.service';

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

function queryString(req: AppRequest, key: string): string {
  const value = req.query[key];
  return typeof value === 'string' ? value : '';
}

async function frontendRedirect(res: FastifyReply, query: Record<string, string>): Promise<void> {
  const { url } = await new SignInSettings().publicUrl();
  const base = url.replace(/\/$/, '') || '';
  const params = new URLSearchParams(query);
  res.redirect(`${base || ''}/?${params.toString()}`);
}

/** CRUD + resolve for the signed-in user's App Secrets vault + named cloud credentials. */
export function createAppSecretsRoutes(
  store: AppSecretsStore,
  providers = new CloudProviderCredentialsStore(),
  gcpOAuth = new GcpOAuthService(providers)
): Router {
  const router = Router();

  router.get('/', requirePermissions('secrets.view'), async (req: AuthedRequest, res: FastifyReply) => {
    res.send({ secrets: await store.list(scopeOf(req)!) });
  });

  router.get('/providers', requirePermissions('secrets.view'), async (req: AuthedRequest, res: FastifyReply) => {
    res.send({ providers: await providers.list(scopeOf(req)!) });
  });

  router.get(
    '/providers/gcp/oauth/start',
    requirePermissions('secrets.create'),
    async (req: AuthedRequest, res: FastifyReply) => {
      try {
        const started = await gcpOAuth.beginConnect(req, scopeOf(req)!, queryString(req, 'name'));
        gcpOAuth.setStateCookie(res, started.cookie);
        res.redirect(started.url);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to start Google Cloud connect';
        const status = /not configured|Invalid credential name|own Google OAuth/i.test(msg) ? 400 : 500;
        if (status === 400) {
          sendError(res, 'invalid_input', msg);
          return;
        }
        sendThrown(res, error, msg);
      }
    }
  );

  router.get(
    '/providers/gcp/oauth/callback',
    requirePermissions('secrets.create'),
    async (req: AuthedRequest, res: FastifyReply) => {
      try {
        const googleError = queryString(req, 'error');
        if (googleError) {
          throw new Error('Google Cloud connect was cancelled or refused.');
        }
        await gcpOAuth.completeConnect(req, scopeOf(req)!, {
          code: queryString(req, 'code'),
          state: queryString(req, 'state'),
          cookie: readGcpOAuthStateCookie(req),
        });
        gcpOAuth.clearStateCookie(res);
        await frontendRedirect(res, { gcp_oauth: 'connected' });
      } catch (error: unknown) {
        gcpOAuth.clearStateCookie(res);
        const message =
          error instanceof Error ? error.message : 'Google Cloud connect failed';
        await frontendRedirect(res, { gcp_oauth: 'error', gcp_oauth_error: message });
      }
    }
  );

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
    const removed = await gcpOAuth.disconnect(scopeOf(req)!, String(req.params.id));
    if (!removed) {
      sendError(res, 'not_found', 'Cloud credential not found');
      return;
    }
    res.send({ ok: true });
  });

  router.post(
    '/providers/:id/gcp/disconnect',
    requirePermissions('secrets.delete'),
    async (req: AuthedRequest, res: FastifyReply) => {
      const removed = await gcpOAuth.disconnect(scopeOf(req)!, String(req.params.id));
      if (!removed) {
        sendError(res, 'not_found', 'Cloud credential not found');
        return;
      }
      res.send({ ok: true });
    }
  );

  router.get(
    '/providers/:id/gcp/projects',
    requirePermissions('secrets.view'),
    async (req: AuthedRequest, res: FastifyReply) => {
      try {
        res.send({ projects: await gcpOAuth.listProjects(scopeOf(req)!, String(req.params.id)) });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to list GCP projects';
        if (/not found/i.test(msg)) {
          sendError(res, 'not_found', msg);
          return;
        }
        if (/not Google Cloud|required|not configured/i.test(msg)) {
          sendError(res, 'invalid_input', msg);
          return;
        }
        sendThrown(res, error, msg);
      }
    }
  );

  router.get(
    '/providers/:id/gcp/secrets',
    requirePermissions('secrets.view'),
    async (req: AuthedRequest, res: FastifyReply) => {
      try {
        res.send({
          secrets: await gcpOAuth.listSecrets(
            scopeOf(req)!,
            String(req.params.id),
            queryString(req, 'project')
          ),
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to list GCP secrets';
        if (/not found/i.test(msg)) {
          sendError(res, 'not_found', msg);
          return;
        }
        if (/not Google Cloud|required|not configured/i.test(msg)) {
          sendError(res, 'invalid_input', msg);
          return;
        }
        sendThrown(res, error, msg);
      }
    }
  );

  router.get(
    '/providers/:id/gcp/secrets/:secretId/versions',
    requirePermissions('secrets.view'),
    async (req: AuthedRequest, res: FastifyReply) => {
      try {
        res.send({
          versions: await gcpOAuth.listVersions(
            scopeOf(req)!,
            String(req.params.id),
            String(req.params.secretId ?? ''),
            queryString(req, 'project')
          ),
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to list GCP secret versions';
        if (/not found/i.test(msg)) {
          sendError(res, 'not_found', msg);
          return;
        }
        if (/not Google Cloud|required|not configured/i.test(msg)) {
          sendError(res, 'invalid_input', msg);
          return;
        }
        sendThrown(res, error, msg);
      }
    }
  );

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
