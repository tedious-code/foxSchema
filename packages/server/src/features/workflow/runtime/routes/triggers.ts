/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/routes/triggers.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  RUN_OUTPUT_EVENT,
  TriggerAuthenticationError,
  authenticateHttpTrigger,
  headerValue,
  isTerminalRunStatus,
  validateAgainstSchema,
  type TriggerDef,
  type TriggerInvocation,
  type WorkflowDef,
} from '@foxschema/workflow-engine';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from '../zod-provider.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';

/** The shape both route families hand to the shared ingress handler. */
interface IngressRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: unknown;
  body?: unknown;
  url: string;
  query: z.infer<typeof querySchema>;
}

const paramsSchema = z.object({
  workflowId: z.string().min(1),
  triggerId: z.string().min(1),
});

/**
 * `?wait` holds the request open for the run's answer. Bounded because an HTTP
 * client and its proxies will give up anyway — better to return a run id the
 * caller can poll than to hang a socket until something else kills it.
 */
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 10_000;

/**
 * `wait` is a flag and `waitMs` is a budget, deliberately kept apart. Folding
 * them into one parameter makes `?wait=1` ambiguous — it reads as "yes" to a
 * caller and as "one millisecond" to a number parser, and the millisecond
 * reading wins silently, so the request returns `timeout` before the run has
 * drawn breath.
 */
const querySchema = z.object({
  wait: z.enum(['1', 'true', '0', 'false']).optional(),
  waitMs: z.coerce.number().int().positive().optional(),
});

/** Methods a webhook may be configured to answer, so the routes can exist. */
const INGRESS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export function triggerRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    /**
     * Vanity paths, resolved by scanning saved workflows.
     *
     * Registered as one wildcard route per method rather than a route per
     * configured path: paths change whenever a workflow is saved, and Fastify's
     * router is built once at boot. Scanning costs a workflow list per request
     * on a route nobody hits unless they configured a path.
     */
    for (const method of INGRESS_METHODS) {
      r.route({
        method,
        url: '/hooks/*',
        config: {
          rawBody: true,
          rateLimit: { max: 60, timeWindow: '1 minute' },
        },
        schema: { querystring: querySchema },
        handler: async (req, reply) => {
          const path = (req.params as { '*'?: string })['*'] ?? '';
          const match = await findByPath(ctx, path);
          if (!match) {
            return reply.code(404).send({ error: 'no webhook at this path' });
          }
          return handleIngress(
            ctx,
            reply,
            req,
            match.workflow,
            match.trigger,
            method,
          );
        },
      });
    }

    for (const method of INGRESS_METHODS) {
      r.route({
        method,
        url: '/triggers/:workflowId/:triggerId',
        config: {
          rawBody: true,
          rateLimit: { max: 60, timeWindow: '1 minute' },
        },
        schema: { params: paramsSchema, querystring: querySchema },
        handler: async (req, reply) => {
          const params = req.params as z.infer<typeof paramsSchema>;
          const workflow = await ctx.workflows.get(params.workflowId);
          if (!workflow) {
            return reply.code(404).send({ error: 'workflow not found' });
          }
          const trigger = workflow.triggers.find(
            (candidate) => candidate.id === params.triggerId,
          );
          if (!trigger) {
            return reply.code(404).send({ error: 'listener trigger not found' });
          }
          return handleIngress(ctx, reply, req, workflow, trigger, method);
        },
      });
    }
  };
}

/**
 * Find the webhook serving a vanity path. Only enabled webhook triggers count,
 * so disabling one frees its path rather than leaving a 409 squatting on it.
 */
async function findByPath(
  ctx: AppContext,
  path: string,
): Promise<{ workflow: WorkflowDef; trigger: TriggerDef } | undefined> {
  if (!path) return undefined;
  for (const workflow of await ctx.workflows.list()) {
    for (const trigger of workflow.triggers) {
      if (
        trigger.kind === 'webhook' &&
        trigger.enabled &&
        trigger.path === path
      ) {
        return { workflow, trigger };
      }
    }
  }
  return undefined;
}

async function handleIngress(
  ctx: AppContext,
  reply: FastifyReply,
  req: IngressRequest,
  workflow: WorkflowDef,
  trigger: TriggerDef,
  method: (typeof INGRESS_METHODS)[number],
): Promise<unknown> {
  const waitMs = requestedWait(req.query.wait, req.query.waitMs);

  // `manual`, `cron`, `poll` and `parent` exist but are dispatched internally.
  // Saying "not found" here would send integrators hunting for a trigger that
  // is sitting right there in the document.
  if (trigger.kind !== 'webhook' && trigger.kind !== 'http') {
    return reply
      .code(405)
      .send({ error: `${trigger.kind} is not an HTTP ingress trigger` });
  }
  if (!trigger.enabled) {
    return reply.code(409).send({ error: 'trigger is disabled' });
  }
  // `http` predates configurable methods and has always been POST-only.
  const allowed = trigger.kind === 'webhook' ? trigger.methods : ['POST'];
  if (!allowed.includes(method)) {
    return reply
      .header('allow', allowed.join(', '))
      .code(405)
      .send({ error: `${method} not allowed on this trigger` });
  }

  // GET and DELETE legitimately carry nothing, so an absent raw body is
  // normal there and an empty buffer is its honest representation. For the
  // methods that do carry one, an absent raw body means the rawBody plugin is
  // not wired — a misconfiguration worth failing on rather than authenticating
  // an empty payload against a signature computed over the real one.
  const bodyless = method === 'GET' || method === 'DELETE';
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : bodyless
      ? Buffer.alloc(0)
      : undefined;
  if (!rawBody) {
    return reply.code(400).send({ error: 'raw request body unavailable' });
  }
  if (rawBody.byteLength > trigger.maxBodyBytes) {
    return reply.code(413).send({ error: 'trigger payload too large' });
  }

  // Read before authenticating: the signature scheme binds the idempotency key
  // into the digest, so it is an input to verification, not just bookkeeping.
  const suppliedIdempotencyKey = headerValue(
    req.headers,
    trigger.idempotencyHeader,
  )?.trim();

  try {
    await authenticateHttpTrigger(
      trigger,
      req.headers,
      rawBody,
      ctx.credentials,
      suppliedIdempotencyKey,
    );
  } catch (error) {
    if (error instanceof TriggerAuthenticationError) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    throw error;
  }
  if (trigger.kind === 'http') {
    const missing = missingFields(req.body, trigger.requiredFields);
    if (missing.length > 0) {
      return reply.code(400).send({
        error: `missing required trigger fields: ${missing.join(', ')}`,
      });
    }
  }

  // Method and URL join the body: a GET webhook has no body at all, so hashing
  // only that would make every request to it look like the same one and
  // collapse them into a single invocation.
  const fingerprint = createHash('sha256')
    .update(`${method}\n${req.url}\n`)
    .update(rawBody)
    .digest('hex');

  const idempotencyKey = suppliedIdempotencyKey ?? derivedKey(trigger, fingerprint);
  if (!idempotencyKey) {
    return reply.code(400).send({ error: 'idempotency key is required' });
  }

  const invocation: TriggerInvocation = {
    id: randomUUID(),
    workflowId: workflow.id,
    triggerId: trigger.id,
    kind: trigger.kind,
    acceptedAt: new Date().toISOString(),
    payload: req.body,
    idempotencyKey,
    fingerprint,
    metadata: {
      contentType:
        headerValue(req.headers, 'content-type') ?? 'application/json',
      method,
    },
  };
  let result;
  try {
    result = await ctx.scheduler.enqueue(workflow, invocation);
  } catch (error) {
    // The workflow's inputSchema rejected the request body.
    if ((error as Error).name === 'WorkflowInputError') {
      return reply.code(400).send({ error: (error as Error).message });
    }
    throw error;
  }
  // `?wait=1` turns the workflow into a callable API: hold the request open
  // until the run finishes and return what `sink.response` collected. Without
  // it the contract is unchanged — 202 and a run id, which is what an import
  // or a migration wants.
  if (result.accepted && result.run && waitMs > 0) {
    return respondWhenFinished(reply, ctx, result.run.id, waitMs);
  }

  // A disabled or draining engine is a temporary refusal, so callers retry.
  const status = result.reason === 'conflict' ? 409 : result.reason === 'disabled' ? 503 : 202;
  return reply.code(status).send({
    accepted: result.accepted,
    runId: result.run?.id,
    status: result.run?.status,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.detail ? { detail: result.detail } : {}),
  });
}

/**
 * Fall back to the request fingerprint when the caller sent no idempotency
 * header, if the trigger opted in. Returns undefined otherwise, which the
 * caller turns into the original 400.
 */
function derivedKey(
  trigger: TriggerDef,
  fingerprint: string,
): string | undefined {
  if (trigger.kind !== 'webhook') return undefined;
  return trigger.onMissingIdempotencyKey === 'fingerprint'
    ? `fingerprint:${fingerprint}`
    : undefined;
}

/**
 * How long to hold the request: `waitMs` wins when given, otherwise `wait` is a
 * yes/no flag using the default budget. Absent or falsy means don't wait, which
 * keeps the original `202` contract for imports and migrations.
 */
function requestedWait(
  wait: '1' | 'true' | '0' | 'false' | undefined,
  waitMs: number | undefined,
): number {
  if (waitMs !== undefined) return Math.min(waitMs, MAX_WAIT_MS);
  return wait === '1' || wait === 'true' ? DEFAULT_WAIT_MS : 0;
}

/**
 * Hold the request until the run settles, then answer with what
 * `sink.response` collected.
 *
 * Polling the run record rather than subscribing: a run finishing is a single
 * edge, the store is local SQLite, and this keeps the wait path independent of
 * the event-stream machinery.
 */
async function respondWhenFinished(
  reply: FastifyReply,
  ctx: AppContext,
  runId: string,
  waitMs: number,
): Promise<unknown> {
  const deadline = Date.now() + waitMs;
  let run = await ctx.runs.get(runId);
  // Quick at first, for a run that answers in milliseconds, then backing off:
  // a thirty-second wait costs a few dozen reads rather than twelve hundred.
  let delayMs = 25;

  while (run && !isTerminalRunStatus(run.status)) {
    if (Date.now() >= deadline) {
      // Not an error: the run is still going. Hand back the id so the caller
      // can poll, and say plainly that this is a timeout rather than a result.
      return reply.code(202).send({
        accepted: true,
        runId,
        status: run.status,
        reason: 'timeout',
      });
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now()))),
    );
    delayMs = Math.min(delayMs * 2, 250);
    run = await ctx.runs.get(runId);
  }
  if (!run) return reply.code(404).send({ error: 'run not found' });

  const events = await ctx.events.list(runId);
  const outputEvent = events.find((event) => event.type === RUN_OUTPUT_EVENT);
  const records = (outputEvent?.data?.records ?? []) as Record<
    string,
    unknown
  >[];

  if (run.status !== 'succeeded') {
    return reply
      .code(502)
      .send({ runId, status: run.status, error: run.error ?? 'run failed' });
  }

  // A declared outputSchema is a promise to the caller, so check it before
  // answering rather than shipping a shape the workflow said it would not.
  const workflow = await ctx.runs.getSnapshot(runId);
  if (workflow?.outputSchema) {
    const message = validateAgainstSchema(workflow.outputSchema, records);
    if (message !== null) {
      return reply.code(502).send({
        runId,
        status: run.status,
        error: `workflow output failed its outputSchema: ${message}`,
      });
    }
  }

  return reply.code(200).send({ runId, status: run.status, output: records });
}

function missingFields(payload: unknown, required: string[]): string[] {
  if (required.length === 0) return [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return required;
  }
  return required.filter(
    (field) => !(field in (payload as Record<string, unknown>)),
  );
}
