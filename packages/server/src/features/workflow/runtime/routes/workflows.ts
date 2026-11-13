/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/routes/workflows.ts).
 */
import {
  assertKnownFromPorts,
  assertNoWorkflowCycles,
  assertRunnableRoots,
  parseWorkflowInput,
  planExecution,
  planWorkflow,
  type WorkflowDef,
} from '@foxschema/workflow-engine';
import { ACTIVE_RUN_STATUSES } from '@foxschema/workflow-engine';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '../zod-provider.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { dryRunWorkflow } from '../dry-run.js';
import {
  addPipeline,
  assertExpectedVersion,
  removePipeline,
  WorkflowMutationError,
} from '../workflow-mutation.js';
import {
  extractPipeline,
  ExtractPipelineError,
} from '../workflow-extract.js';
import {
  buildWorkflowPackage,
  importWorkflowPackage,
} from '../workflow-package.js';
import { proposeWorkflow } from '../workflow-propose.js';

// The body of validate/put is intentionally unvalidated by fastify:
// parseWorkflowInput accepts either a full workflow document or a bare
// pipeline document (implicitly wrapped), and its zod + graph errors become
// the 400 payload.
function assertKnownMiddleware(
  workflow: WorkflowDef,
  registry: AppContext['middleware'],
): void {
  const unknown = workflow.middleware
    .filter((ref) => !registry.has(ref.name))
    .map((ref) => ref.name);
  if (unknown.length > 0) {
    throw new Error(`unknown middleware: ${unknown.join(', ')}`);
  }
}

/**
 * Everything the API checks before a workflow is allowed near the engine:
 * shape, sub-workflow cycles, known middleware, and pipelines that can
 * actually start. Shared by validate, put and the pipeline mutations so a
 * workflow cannot enter storage through a side door with weaker checks.
 */
async function assertSavable(
  workflow: WorkflowDef,
  ctx: AppContext,
): Promise<void> {
  await assertNoWorkflowCycles(workflow, (id) => ctx.workflows.get(id));
  assertKnownMiddleware(workflow, ctx.middleware);
  await assertWebhookPathsFree(workflow, ctx);
  for (const pipeline of workflow.pipelines) {
    assertRunnableRoots(pipeline);
    assertPipesUsable(pipeline, ctx.registry);
  }
}

/**
 * A webhook's vanity path is a global name, so two workflows cannot hold the
 * same one. Checked at save rather than at request time: the alternative is
 * whichever workflow the list happens to yield first silently winning, which
 * is the kind of ambiguity that is discovered in production.
 *
 * Within one document, duplicate paths are caught here too — the same trigger
 * id cannot repeat, but two different triggers could name the same path.
 */
async function assertWebhookPathsFree(
  workflow: WorkflowDef,
  ctx: AppContext,
): Promise<void> {
  const claimed = new Map<string, string>();
  for (const trigger of workflow.triggers) {
    if (trigger.kind !== 'webhook' || !trigger.path) continue;
    const existing = claimed.get(trigger.path);
    if (existing) {
      throw new Error(
        `triggers ${existing} and ${trigger.id} both use webhook path "${trigger.path}"`,
      );
    }
    claimed.set(trigger.path, trigger.id);
  }
  if (claimed.size === 0) return;

  for (const other of await ctx.workflows.list()) {
    // Saving over yourself is not a collision with yourself.
    if (other.id === workflow.id) continue;
    for (const trigger of other.triggers) {
      if (trigger.kind !== 'webhook' || !trigger.path) continue;
      if (claimed.has(trigger.path)) {
        throw new Error(
          `webhook path "${trigger.path}" is already used by workflow ${other.id}`,
        );
      }
    }
  }
}

/**
 * Every pipe must be a real registered type, in a role that type supports, with
 * config its own schema accepts.
 *
 * Without this a workflow naming a pipe type that does not exist — or a
 * `sink.postgres` with no table — saved with a cheerful `200` and failed at
 * 3am. `registry.get` is the same call the executor makes, so what passes here
 * is exactly what the engine will accept; the error is re-thrown with the
 * pipeline and pipe id because the raw message says only which *type* failed,
 * and a workflow can have several of the same type.
 */
function assertPipesUsable(
  pipeline: WorkflowDef['pipelines'][number],
  registry: AppContext['registry'],
): void {
  for (const pipe of pipeline.pipes) {
    try {
      registry.get(pipe);
    } catch (err) {
      throw new Error(
        `pipeline ${pipeline.id}, pipe ${pipe.id}: ${describeValidationError(err)}`,
      );
    }
  }
  // The executor makes this same check before the first batch moves; making
  // it here too means an edge wired to a port the pipe does not have is
  // refused at save, not discovered when a scheduled run fails.
  try {
    assertKnownFromPorts(
      registry,
      new Map(pipeline.pipes.map((pipe) => [pipe.id, pipe])),
      pipeline.edges,
    );
  } catch (err) {
    throw new Error(`pipeline ${pipeline.id}: ${(err as Error).message}`);
  }
}

function plansFor(workflow: WorkflowDef) {
  return {
    ...planWorkflow(workflow),
    pipelines: Object.fromEntries(
      workflow.pipelines.map((p) => [p.id, planExecution(p)]),
    ),
  };
}

/**
 * Turn a validation failure into one sentence an agent can act on.
 *
 * These endpoints exist for callers that write workflows programmatically and
 * retry on rejection. A raw `ZodError` serialises as a JSON array of issue
 * objects, and its `path` indexes the *merged* workflow — `pipelines.2.name`
 * for a caller that submitted a single pipeline and never saw index 2. That
 * costs the agent a parse and a translation before it can fix anything.
 */
function describeValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
  }
  return (error as Error).message;
}

/** The part of a reply the helpers below use, whatever the route's typing. */
interface RouteReply {
  code(statusCode: number): { send(payload?: unknown): unknown };
}

/** A refused mutation: its own status (404, 409…) when it carries one, else 400. */
function sendMutationError(reply: RouteReply, err: unknown) {
  const status =
    err instanceof WorkflowMutationError || err instanceof ExtractPipelineError
      ? err.status
      : 400;
  return reply.code(status).send({ error: (err as Error).message });
}

/**
 * Store the workflow a pipeline mutation produced, after the same parse and
 * checks a human `PUT` gets, and answer with it and its plan. Nothing is
 * stored unless the whole result is legal.
 */
async function saveMutation(ctx: AppContext, reply: RouteReply, merged: WorkflowDef) {
  let workflow: WorkflowDef;
  try {
    workflow = parseWorkflowInput(merged);
    await assertSavable(workflow, ctx);
  } catch (err) {
    return reply.code(400).send({ error: describeValidationError(err) });
  }
  await ctx.workflows.put(workflow);
  return reply.code(200).send({ workflow, plan: plansFor(workflow) });
}

export function workflowRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // Validate + plan without persisting — powers the designer's "Validate"
    // button. Returns completion waves (pipeline level) plus per-pipeline
    // pipe waves, or the first shape/graph error.
    r.post('/workflows/validate', {}, async (req, reply) => {
      try {
        const workflow = parseWorkflowInput(req.body);
        // Layer 1 circular detection — sub-workflow references against the
        // saved registry (unknown/forward references are allowed).
        await assertSavable(workflow, ctx);
        return { valid: true, plan: plansFor(workflow) };
      } catch (err) {
        return reply
          .code(400)
          .send({ valid: false, error: (err as Error).message });
      }
    });

    r.put(
      '/workflows/:id',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        let workflow;
        try {
          const body = req.body as Record<string, unknown>;
          workflow = parseWorkflowInput({ ...body, id: req.params.id });
          // A save cannot raise a workflow's trust. Imported or proposed stays
          // so whatever the body says — or leaves out, which parses as
          // `authored`: opening an import in the designer and saving it
          // promoted it, the laundering import and extract already refuse.
          const stored = await ctx.workflows.get(req.params.id);
          if (stored && stored.origin !== 'authored') workflow = { ...workflow, origin: stored.origin };
          await assertSavable(workflow, ctx);
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
        await ctx.workflows.put(workflow);
        return reply.code(200).send(workflow);
      },
    );

    /**
     * Run the workflow with its edges to the outside world stood in for: the
     * real executor, real transforms, real port routing — but sources emit the
     * caller's sample rows, sinks record instead of writing, and pipes that
     * reach outside the process pass their batch through.
     *
     * Static validation cannot tell you whether a map produces the fields the
     * next pipe expects, or whether a condition routes anything down the branch
     * you drew. Only running it can, and running it for real writes to
     * production.
     */
    r.post(
      '/workflows/:id/dry-run',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const workflow = await ctx.workflows.get(req.params.id);
        if (!workflow) return reply.code(404).send({ error: 'not found' });

        const body = (req.body ?? {}) as { samples?: Record<string, unknown> };
        const samples = (body.samples ?? {}) as Record<
          string,
          Record<string, unknown>[]
        >;
        return reply
          .code(200)
          .send(await dryRunWorkflow(ctx.registry, workflow, samples));
      },
    );

    r.get('/workflows', {}, async () => {
      const [workflows, summaries] = await Promise.all([
        ctx.workflows.list(),
        ctx.workflows.summaries(),
      ]);
      const updatedAt = new Map(summaries.map((s) => [s.id, s.updatedAt]));
      // Each workflow's latest run: one seek on (workflow_id, started_at)
      // apiece. Reading every run to pick these out cost the whole history on
      // each list — a per-minute cron adds half a million runs a year.
      const latest = await Promise.all(workflows.map((w) => ctx.runs.list(w.id, { limit: 1 })));
      const lastRun = new Map(workflows.map((w, index) => [w.id, latest[index]![0]]));
      return workflows.map((w) => {
        const last = lastRun.get(w.id);
        return {
          id: w.id,
          name: w.name,
          description: w.description,
          purpose: w.purpose,
          tags: w.tags ?? [],
          expectedResult: w.expectedResult,
          version: w.version,
          pipelines: w.pipelines.length,
          pipes: w.pipelines.reduce((n, p) => n + p.pipes.length, 0),
          callable: w.triggers.some(
            (trigger) => trigger.kind === 'parent' && trigger.enabled,
          ),
          triggers: w.triggers.map((trigger) => ({
            id: trigger.id,
            kind: trigger.kind,
            enabled: trigger.enabled,
          })),
          updatedAt: updatedAt.get(w.id),
          ...(last
            ? {
                lastRun: {
                  id: last.id,
                  status: last.status,
                  startedAt: last.startedAt,
                },
              }
            : {}),
        };
      });
    });

    /** Import a package; optional credential remap + id override. */
    r.post('/workflows/import', {}, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const imported = importWorkflowPackage({
          package: body.package as never,
          ...(body.credentialMap && typeof body.credentialMap === 'object'
            ? {
                credentialMap: body.credentialMap as Record<string, string>,
              }
            : {}),
          ...(typeof body.workflowId === 'string'
            ? { workflowId: body.workflowId }
            : {}),
        });
        const workflow = parseWorkflowInput(imported);
        if (await ctx.workflows.get(workflow.id)) {
          return reply
            .code(409)
            .send({ error: `workflow already exists: ${workflow.id}` });
        }
        await assertSavable(workflow, ctx);
        await ctx.workflows.put(workflow);
        return reply.code(201).send(workflow);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    /**
     * Propose a thin orchestration workflow that reuses callable catalog
     * entries (Agentic OS Phase F).
     */
    r.post('/agent/propose-workflow', {}, async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const catalog = await ctx.workflows.list();
        const result = proposeWorkflow({
          purpose: String(body.purpose ?? ''),
          id: String(body.id ?? ''),
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
          ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
          catalog,
        });
        // Validate shape without requiring sub-workflows to exist as savable
        // yet — propose is a draft. Still parse so agents get a legal doc.
        const workflow = parseWorkflowInput(result.workflow);
        return {
          workflow,
          reused: result.reused,
          notes: result.notes,
        };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    /**
     * Extend a saved workflow with one pipeline, instead of re-authoring the
     * whole document. This is the seam an agent uses: regenerating a workflow to
     * add a nightly reconciliation step is how the parts it forgot to mention
     * get silently dropped.
     *
     * The merged document goes through the same parse, cycle and middleware
     * checks a human `PUT` goes through, so this cannot install a workflow a
     * human could not have saved, and nothing is persisted unless the whole
     * result is legal.
     */
    r.post(
      '/workflows/:id/pipelines',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const current = await ctx.workflows.get(req.params.id);
        if (!current) return reply.code(404).send({ error: 'not found' });

        const body = (req.body ?? {}) as Record<string, unknown>;
        let merged: WorkflowDef;
        try {
          assertExpectedVersion(current, body.expectedVersion as number | undefined);
          merged = addPipeline(current, {
            pipeline: body.pipeline as never,
            dependsOn: body.dependsOn as never,
            feeds: body.feeds as never,
            replace: body.replace === true,
          });
        } catch (err) {
          return sendMutationError(reply, err);
        }
        return saveMutation(ctx, reply, merged);
      },
    );

    r.delete(
      '/workflows/:id/pipelines/:pipelineId',
      {
        schema: {
          params: z.object({ id: z.string(), pipelineId: z.string() }),
          querystring: z.object({ expectedVersion: z.coerce.number().optional() }),
        },
      },
      async (req, reply) => {
        const current = await ctx.workflows.get(req.params.id);
        if (!current) return reply.code(404).send({ error: 'not found' });

        let merged: WorkflowDef;
        try {
          assertExpectedVersion(current, req.query.expectedVersion);
          merged = removePipeline(current, req.params.pipelineId);
        } catch (err) {
          return sendMutationError(reply, err);
        }
        return saveMutation(ctx, reply, merged);
      },
    );

    r.delete(
      '/workflows/:id',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        if (!(await ctx.workflows.get(req.params.id))) {
          return reply.code(404).send({ error: 'not found' });
        }
        // An in-flight run still needs its definition reachable for resume, so
        // refuse rather than delete out from under it. Finished runs are safe:
        // they carry their own immutable snapshot.
        const [active] = await ctx.runs.list(req.params.id, {
          status: ACTIVE_RUN_STATUSES,
          limit: 1,
        });
        if (active) {
          return reply.code(409).send({
            error: `workflow has an active run (${active.id}); cancel it first`,
          });
        }
        await ctx.workflows.remove(req.params.id);
        // Cron state is keyed by workflow; drop it so the coordinator doesn't
        // keep a schedule for a workflow that no longer exists.
        for (const schedule of await ctx.schedules.list()) {
          if (schedule.workflowId === req.params.id) {
            await ctx.schedules.remove(schedule.workflowId, schedule.triggerId);
          }
        }
        // Workflow-scoped variables (across every environment) would be
        // orphans nothing can list or resolve — remove them too. Globals and
        // run snapshots are untouched.
        for (const variable of await ctx.variables.list({
          scope: 'workflow',
          workflowId: req.params.id,
        })) {
          await ctx.variables.remove(variable.id);
        }
        return reply.code(204).send();
      },
    );

    r.post(
      '/workflows/:id/duplicate',
      {
        schema: {
          params: z.object({ id: z.string() }),
          body: z.object({
            id: z.string().min(1).max(120),
            name: z.string().min(1).max(120).optional(),
          }),
        },
      },
      async (req, reply) => {
        const source = await ctx.workflows.get(req.params.id);
        if (!source) return reply.code(404).send({ error: 'not found' });
        if (await ctx.workflows.get(req.body.id)) {
          return reply
            .code(409)
            .send({ error: `workflow already exists: ${req.body.id}` });
        }
        // A copy starts its own history at version 1. A webhook's vanity path
        // is a global name, so the copy gives its paths up rather than share
        // them — sharing let the copy answer the original's webhook calls —
        // and then passes the same checks as any other save.
        let copy: WorkflowDef;
        try {
          copy = parseWorkflowInput({
            ...source,
            id: req.body.id,
            name: req.body.name ?? `${source.name} copy`,
            version: 1,
            triggers: source.triggers.map((trigger) => {
              if (trigger.kind !== 'webhook' || !trigger.path) return trigger;
              const { path: _taken, ...rest } = trigger;
              return rest;
            }),
          });
          await assertSavable(copy, ctx);
        } catch (err) {
          return reply.code(400).send({ error: describeValidationError(err) });
        }
        await ctx.workflows.put(copy);
        return reply.code(201).send(copy);
      },
    );

    r.get(
      '/workflows/:id',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const workflow = await ctx.workflows.get(req.params.id);
        return workflow ? workflow : reply.code(404).send({ error: 'not found' });
      },
    );

    /**
     * Promote a pipeline into a reusable callable workflow and replace it with
     * workflow.sub in the source (Agentic OS Phase B).
     */
    r.post(
      '/workflows/:id/extract-pipeline',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const current = await ctx.workflows.get(req.params.id);
        if (!current) return reply.code(404).send({ error: 'not found' });
        const body = (req.body ?? {}) as Record<string, unknown>;
        try {
          assertExpectedVersion(current, body.expectedVersion as number | undefined);
        } catch (err) {
          return sendMutationError(reply, err);
        }

        let extracted;
        let source;
        try {
          const result = extractPipeline(current, {
            pipelineId: String(body.pipelineId ?? ''),
            newWorkflowId: String(body.newWorkflowId ?? ''),
            ...(typeof body.newWorkflowName === 'string'
              ? { newWorkflowName: body.newWorkflowName }
              : {}),
            ...(typeof body.purpose === 'string' ? { purpose: body.purpose } : {}),
            ...(Array.isArray(body.tags)
              ? { tags: body.tags.map(String) }
              : {}),
            ...(typeof body.expectedResult === 'string'
              ? { expectedResult: body.expectedResult }
              : {}),
            replaceWithSub: body.replaceWithSub !== false,
            pinVersion: body.pinVersion !== false,
          });
          extracted = parseWorkflowInput(result.extracted);
          source = parseWorkflowInput(result.source);
          await assertSavable(extracted, ctx);
          await assertSavable(source, ctx);
        } catch (err) {
          const status =
            err instanceof ExtractPipelineError ? err.status : 400;
          return reply.code(status).send({ error: (err as Error).message });
        }

        if (await ctx.workflows.get(extracted.id)) {
          return reply
            .code(409)
            .send({ error: `workflow already exists: ${extracted.id}` });
        }
        await ctx.workflows.put(extracted);
        await ctx.workflows.put(source);
        return reply.code(201).send({
          source,
          extracted,
          plan: plansFor(source),
        });
      },
    );

    /**
     * Export a shareable package. Credentials are reduced to id + kind, but
     * the workflow travels verbatim — so anything typed straight into a pipe
     * config goes with it. `manifest.inlineSecretWarnings` flags what looked
     * like a secret; check it before sharing the file.
     */
    r.get(
      '/workflows/:id/export',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const workflow = await ctx.workflows.get(req.params.id);
        if (!workflow) return reply.code(404).send({ error: 'not found' });
        const credentials = await ctx.credentials.list();
        return buildWorkflowPackage(workflow, credentials);
      },
    );
  };
}
