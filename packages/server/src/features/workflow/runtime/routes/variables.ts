/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/routes/variables.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '../zod-provider.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const scopeSchema = z.enum(['global', 'workflow']);

const variableBodySchema = z
  .object({
    scope: scopeSchema.default('global'),
    workflowId: z.string().min(1).optional(),
    key: z.string().min(1).max(200),
    value: z.unknown(),
  })
  .refine(
    (input) => input.scope === 'global' || Boolean(input.workflowId),
    { message: 'workflow-scoped variables require a workflowId', path: ['workflowId'] },
  );

/**
 * Environments wrap two variable scopes: `global` (every workflow in that
 * environment) and `workflow` (one workflow, overriding a global of the same
 * key). Exactly one environment is active; runs resolve against it unless the
 * caller overrides per run.
 */
export function variableRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get('/environments', {}, async () => ({
      environments: await ctx.environments.list(),
    }));

    r.post(
      '/environments',
      { schema: { body: z.object({ name: z.string().min(1).max(80) }) } },
      async (req, reply) => {
        if (await ctx.environments.getByName(req.body.name)) {
          return reply
            .code(409)
            .send({ error: `environment already exists: ${req.body.name}` });
        }
        return reply.code(201).send(await ctx.environments.create(req.body));
      },
    );

    r.post(
      '/environments/:id/activate',
      { schema: { params: z.object({ id: z.string().min(1) }) } },
      async (req, reply) => {
        const activated = await ctx.environments.activate(req.params.id);
        return activated ?? reply.code(404).send({ error: 'not found' });
      },
    );

    r.patch(
      '/environments/:id',
      {
        schema: {
          params: z.object({ id: z.string().min(1) }),
          body: z.object({ name: z.string().min(1).max(80) }),
        },
      },
      async (req, reply) => {
        const existing = await ctx.environments.getByName(req.body.name);
        if (existing && existing.id !== req.params.id) {
          return reply
            .code(409)
            .send({ error: `environment already exists: ${req.body.name}` });
        }
        const renamed = await ctx.environments.rename(
          req.params.id,
          req.body.name,
        );
        return renamed ?? reply.code(404).send({ error: 'not found' });
      },
    );

    r.delete(
      '/environments/:id',
      { schema: { params: z.object({ id: z.string().min(1) }) } },
      async (req, reply) => {
        const environment = await ctx.environments.get(req.params.id);
        if (!environment) return reply.code(404).send({ error: 'not found' });
        // Deleting the active environment would leave runs with no variables
        // and no obvious successor — make the caller activate another first.
        if (environment.isActive && (await ctx.environments.list()).length > 1) {
          return reply.code(409).send({
            error: 'cannot delete the active environment; activate another first',
          });
        }
        await ctx.environments.remove(req.params.id);
        return reply.code(204).send();
      },
    );

    r.get(
      '/environments/:id/variables',
      {
        schema: {
          params: z.object({ id: z.string().min(1) }),
          querystring: z.object({
            scope: scopeSchema.optional(),
            workflowId: z.string().min(1).optional(),
          }),
        },
      },
      async (req, reply) => {
        if (!(await ctx.environments.get(req.params.id))) {
          return reply.code(404).send({ error: 'environment not found' });
        }
        return {
          variables: await ctx.variables.list({
            environmentId: req.params.id,
            ...(req.query.scope ? { scope: req.query.scope } : {}),
            ...(req.query.workflowId
              ? { workflowId: req.query.workflowId }
              : {}),
          }),
        };
      },
    );

    r.put(
      '/environments/:id/variables',
      {
        schema: {
          params: z.object({ id: z.string().min(1) }),
          body: variableBodySchema,
        },
      },
      async (req, reply) => {
        if (!(await ctx.environments.get(req.params.id))) {
          return reply.code(404).send({ error: 'environment not found' });
        }
        return ctx.variables.put({
          environmentId: req.params.id,
          scope: req.body.scope,
          ...(req.body.workflowId ? { workflowId: req.body.workflowId } : {}),
          key: req.body.key,
          value: req.body.value ?? null,
        });
      },
    );

    r.delete(
      '/variables/:id',
      { schema: { params: z.object({ id: z.string().min(1) }) } },
      async (req, reply) =>
        (await ctx.variables.remove(req.params.id))
          ? reply.code(204).send()
          : reply.code(404).send({ error: 'not found' }),
    );

    /**
     * Copy one variable's key into other environments — the "same name across
     * dev/staging/prod" workflow. Values are per-environment: `value` seeds the
     * copies, else the source value is reused. Existing keys are skipped unless
     * `overwrite`, so cloning never clobbers a tuned prod value by accident.
     */
    r.post(
      '/variables/clone',
      {
        schema: {
          body: z.object({
            sourceEnvironmentId: z.string().min(1),
            targetEnvironmentIds: z.array(z.string().min(1)).min(1).max(50),
            scope: scopeSchema.default('global'),
            workflowId: z.string().min(1).optional(),
            key: z.string().min(1),
            value: z.unknown().optional(),
            overwrite: z.boolean().default(false),
          }),
        },
      },
      async (req, reply) => {
        const { sourceEnvironmentId, targetEnvironmentIds, scope, key } = req.body;
        const workflowId = req.body.workflowId;
        if (scope === 'workflow' && !workflowId) {
          return reply
            .code(400)
            .send({ error: 'workflow-scoped clone requires a workflowId' });
        }
        const source = (
          await ctx.variables.list({
            environmentId: sourceEnvironmentId,
            scope,
            ...(workflowId ? { workflowId } : { workflowId: '' }),
          })
        ).find((variable) => variable.key === key);
        if (!source && req.body.value === undefined) {
          return reply
            .code(404)
            .send({ error: `variable not found in source environment: ${key}` });
        }

        const cloned: string[] = [];
        const skipped: string[] = [];
        for (const targetId of targetEnvironmentIds) {
          if (targetId === sourceEnvironmentId) continue;
          if (!(await ctx.environments.get(targetId))) {
            return reply
              .code(404)
              .send({ error: `environment not found: ${targetId}` });
          }
          if (!req.body.overwrite) {
            const existing = (
              await ctx.variables.list({
                environmentId: targetId,
                scope,
                ...(workflowId ? { workflowId } : { workflowId: '' }),
              })
            ).some((variable) => variable.key === key);
            if (existing) {
              skipped.push(targetId);
              continue;
            }
          }
          await ctx.variables.put({
            environmentId: targetId,
            scope,
            ...(workflowId ? { workflowId } : {}),
            key,
            value: req.body.value ?? source?.value ?? null,
          });
          cloned.push(targetId);
        }
        return { key, cloned, skipped };
      },
    );

    /** What a run of `workflowId` would see right now, for the designer. */
    r.get(
      '/variables/resolved',
      {
        schema: {
          querystring: z.object({
            workflowId: z.string().min(1),
            environmentId: z.string().min(1).optional(),
          }),
        },
      },
      async (req, reply) => {
        const environment = req.query.environmentId
          ? await ctx.environments.get(req.query.environmentId)
          : await ctx.environments.active();
        if (!environment) {
          return req.query.environmentId
            ? reply.code(404).send({ error: 'environment not found' })
            : { environment: null, variables: {} };
        }
        return {
          environment,
          variables: await ctx.variables.resolve(
            environment.id,
            req.query.workflowId,
          ),
        };
      },
    );
  };
}
