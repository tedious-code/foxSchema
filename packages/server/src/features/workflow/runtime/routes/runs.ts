/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/routes/runs.ts).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '../zod-provider.js';
import { z } from 'zod';
import { RUN_STREAM_END_EVENT } from '@foxschema/workflow-contract';
import { applyPredicate, isTerminalRunStatus, redactAnswer, type HumanInputField } from '@foxschema/workflow-engine';
import { assertNoWorkflowCycles } from '@foxschema/workflow-engine';
import type { AppContext } from '../context.js';
import { buildRunFailureSummary } from '../run-failure.js';

/** Optional per-run environment override and designer debug capture. */
const runBodySchema = z.object({
  environment: z.string().min(1).optional(),
  /** When true, the executor emits truncated per-port I/O samples. */
  debug: z.boolean().optional(),
});

export function runRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    /**
     * Live SSE pollers, so shutdown can stop them all at once. Without this a
     * stream's interval could keep querying the event store after onClose has
     * closed the database underneath it.
     */
    const openStreams = new Set<() => void>();
    /** How often a quiet stream checks for what no in-process event announced. */
    const STREAM_FALLBACK_MS = 500;
    app.addHook('onClose', async () => {
      for (const stop of [...openStreams]) stop();
    });

    r.post(
      '/workflows/:id/run',
      { schema: { params: z.object({ id: z.string() }) } },
      // The body is deliberately not in the fastify schema: this endpoint is
      // normally called with no body at all, and a declared body schema 400s
      // those bare POSTs. Parsed by hand below instead.
      async (req, reply) => {
        const workflow = await ctx.workflows.get(req.params.id);
        if (!workflow) {
          return reply.code(404).send({ error: 'workflow not found' });
        }

        // Layer 2 circular detection — re-walk the reference graph at
        // admission; edits to other workflows since save can introduce cycles.
        try {
          await assertNoWorkflowCycles(workflow, (id) => ctx.workflows.get(id));
        } catch (error) {
          return reply.code(400).send({ error: (error as Error).message });
        }

        const body = runBodySchema.safeParse(req.body ?? {});
        if (!body.success) {
          return reply.code(400).send({
            error:
              'body must be { environment?: string, debug?: boolean }',
          });
        }
        const { environment, debug } = body.data;
        let result;
        try {
          result = await ctx.scheduler.enqueue(
            workflow,
            undefined,
            {
              ...(environment ? { environment } : {}),
              ...(debug ? { debug: true } : {}),
            },
          );
        } catch (error) {
          const message = (error as Error).message;
          // Input-contract and unknown-environment failures are the caller's
          // fault, not a conflict.
          const status =
            (error as Error).name === 'WorkflowInputError' ||
            message.startsWith('unknown environment:')
              ? 400
              : 409;
          return reply.code(status).send({ error: message });
        }
        return reply.code(202).send({
          runId: result.run?.id,
          status: result.run?.status,
          accepted: result.accepted,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.detail ? { detail: result.detail } : {}),
        });
      },
    );

    r.get(
      '/runs/:id',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const run = await ctx.runs.get(req.params.id);
        if (!run) return reply.code(404).send({ error: 'not found' });
        const [pipelines, pipes] = await Promise.all([
          ctx.runs.listPipelines(run.id),
          ctx.runs.listPipes(run.id),
        ]);
        return { ...run, pipelines, pipes };
      },
    );

    /**
     * The workflow this run executed. It is not the live document: a later edit
     * or delete leaves the snapshot, and that is what the run's rows came from.
     * FoxSchema reads it to decide who may see those rows. Kept off the run
     * record itself — a list of runs must not carry every definition.
     */
    r.get(
      '/runs/:id/snapshot',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const snapshot = await ctx.runs.getSnapshot(req.params.id);
        if (!snapshot) return reply.code(404).send({ error: 'not found' });
        return snapshot;
      },
    );

    /**
     * Compact failure / outcome summary for agents and the Runs UI
     * (Agentic OS Phase E) — which pipeline/pipe/gate failed, AI failover.
     */
    r.get(
      '/runs/:id/failure',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const run = await ctx.runs.get(req.params.id);
        if (!run) return reply.code(404).send({ error: 'not found' });
        const [pipelines, pipes, events, workflow] = await Promise.all([
          ctx.runs.listPipelines(run.id),
          ctx.runs.listPipes(run.id),
          ctx.events.list(run.id),
          ctx.workflows.get(run.workflowId),
        ]);
        return buildRunFailureSummary({
          run,
          ...(workflow ? { workflow } : {}),
          pipelines,
          pipes,
          events,
        });
      },
    );

    r.get(
      '/runs',
      {
        schema: {
          querystring: z.object({
            workflowId: z.string().min(1).optional(),
            // Newest first, and bounded: run history only grows, and the
            // designer polls this list.
            limit: z.coerce.number().int().min(1).max(1_000).default(200),
          }),
        },
      },
      async (req) => ctx.runs.list(req.query.workflowId, { limit: req.query.limit }),
    );

    r.get(
      '/runs/:id/events',
      {
        schema: {
          params: z.object({ id: z.string() }),
          querystring: z.object({ after: z.coerce.number().int().min(0).default(0) }),
        },
      },
      async (req, reply) => {
        if (!(await ctx.runs.get(req.params.id))) {
          return reply.code(404).send({ error: 'not found' });
        }
        return {
          events: await ctx.events.list(req.params.id, req.query.after),
        };
      },
    );

    r.get(
      '/runs/:id/events/stream',
      {
        schema: {
          params: z.object({ id: z.string() }),
          querystring: z.object({ after: z.coerce.number().int().min(0).default(0) }),
        },
      },
      async (req, reply) => {
        if (!(await ctx.runs.get(req.params.id))) {
          return reply.code(404).send({ error: 'not found' });
        }
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let after = req.query.after;
        let closed = false;
        let writing = false;
        // An event arrived while a flush was running; flush again after it.
        let pending = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        // Woken by the engine as each event of this run is stored, rather than
        // reading the store ten times a second for every open stream — those
        // reads are synchronous SQLite on the loop that also executes runs.
        const unsubscribe = ctx.onEvent((event) => {
          if (event.workflowRunId !== req.params.id) return;
          if (writing) pending = true;
          else void write().catch(() => undefined);
        });
        const stop = () => {
          closed = true;
          clearInterval(timer);
          unsubscribe();
          openStreams.delete(stop);
        };
        openStreams.add(stop);
        // The response, not the request: see the proxy's note on `close`.
        reply.raw.on('close', stop);

        // Set once a terminal run.status has gone out; the stream then only
        // waits for one quiet tick, so nothing appended right after it is lost.
        let finished = false;
        let idleTicks = 0;
        const flush = async (): Promise<number> => {
          const events = await ctx.events.list(req.params.id, after);
          for (const event of events) {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            after = event.seq;
            const status = event.type === 'run.status' ? event.data?.status : undefined;
            if (typeof status === 'string' && isTerminalRunStatus(status)) finished = true;
          }
          return events.length;
        };
        const write = async () => {
          // One at a time: two overlapping reads from the same `after` would
          // send the same events twice.
          if (closed || writing) return;
          writing = true;
          try {
            if ((await flush()) > 0) return;
            if (!finished) {
              // Nothing new, and no event said the run ended — normal while it
              // runs. The run record is read on the first quiet tick and about
              // once a second after, for a client that subscribed past the
              // run's final event.
              if (idleTicks++ % 2 !== 0) return;
              const run = await ctx.runs.get(req.params.id);
              if (closed || (run && !isTerminalRunStatus(run.status))) return;
              await flush(); // anything appended between the two reads
            }
            // Everything the run will emit has been sent. Say so and close: an
            // EventSource reconnects when a stream just ends.
            stop();
            reply.raw.write(`event: ${RUN_STREAM_END_EVENT}\ndata: {}\n\n`);
            reply.raw.end();
          } finally {
            writing = false;
            if (pending && !closed) {
              pending = false;
              void write().catch(() => undefined);
            }
          }
        };
        await write();
        if (closed) return;
        // The fallback for what no in-process event announces: a run another
        // process executes (a worker), and the run record for a client that
        // subscribed after the run's last event.
        timer = setInterval(() => {
          void write().catch(() => undefined);
        }, STREAM_FALLBACK_MS);
        // An open SSE stream must not keep the process alive on its own — the
        // client socket already does that, and this poller would otherwise
        // outlive shutdown and block exit.
        timer.unref?.();
      },
    );

    r.post(
      '/runs/:id/cancel',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const run = await ctx.scheduler.cancel(req.params.id);
        if (!run) return reply.code(404).send({ error: 'not found' });
        return reply.code(202).send({ runId: run.id, status: run.status });
      },
    );

    /**
     * What this run is waiting for a person to supply — the form to render,
     * on a page or a phone. Field *definitions* only: an answer already given
     * is never returned, or this endpoint would be a way to read back every
     * OTP the installation has ever been told.
     */
    r.get(
      '/runs/:id/inputs',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const run = await ctx.runs.get(req.params.id);
        if (!run) return reply.code(404).send({ error: 'not found' });
        const pending = await ctx.humanInputs.pending(req.params.id);
        return {
          runId: run.id,
          status: run.status,
          pending: pending.map((record) => ({
            key: record.request.key,
            prompt: record.request.prompt,
            channel: record.request.channel,
            pipelineId: record.pipelineId,
            expiresAt: record.expiresAt,
            fields: record.request.fields,
          })),
        };
      },
    );

    /**
     * Answer, then resume. One call rather than two because a client that
     * answered and failed to resume would leave the run parked with its
     * question already marked answered — nothing would ever ask again.
     */
    r.post(
      '/runs/:id/inputs',
      {
        schema: {
          params: z.object({ id: z.string() }),
          body: z.object({
            key: z.string().min(1),
            values: z.record(z.string(), z.unknown()),
          }),
        },
      },
      async (req, reply) => {
        const run = await ctx.runs.get(req.params.id);
        if (!run) return reply.code(404).send({ error: 'not found' });

        const record = await ctx.humanInputs.get(req.params.id, req.body.key);
        if (!record) {
          return reply.code(404).send({ error: `no such question: ${req.body.key}` });
        }
        if (record.status !== 'pending') {
          // Answering an expired or already-answered question must not resume
          // the run: the pipe would find a stale value and proceed on it.
          return reply
            .code(409)
            .send({ error: `question is ${record.status}, not pending` });
        }

        const problems = validateAnswer(record.request.fields, req.body.values);
        if (problems.length > 0) {
          return reply.code(400).send({ error: 'invalid answer', problems });
        }

        await ctx.humanInputs.answer(
          req.params.id,
          req.body.key,
          req.body.values,
          new Date().toISOString(),
        );
        await ctx.events.append({
          workflowRunId: run.id,
          pipelineId: record.pipelineId,
          at: new Date().toISOString(),
          type: 'human.input.received',
          message: `answered: ${record.request.key}`,
          // Redacted at the boundary so a new caller cannot forget to.
          data: { key: record.request.key, values: redactAnswer(record.request.fields, req.body.values) },
        });

        try {
          const resumed = await ctx.scheduler.resume(req.params.id);
          return reply.code(202).send({ runId: run.id, status: resumed?.status ?? 'queued' });
        } catch (error) {
          return reply.code(409).send({ error: (error as Error).message });
        }
      },
    );

    r.post(
      '/runs/:id/resume',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        try {
          const run = await ctx.scheduler.resume(req.params.id);
          if (!run) return reply.code(404).send({ error: 'not found' });
          return reply.code(202).send({ runId: run.id, status: 'queued' });
        } catch (error) {
          return reply.code(409).send({ error: (error as Error).message });
        }
      },
    );
  };
}

/**
 * Check an answer against the fields that were asked for.
 *
 * Server-side because the form is only one of the ways in — a phone, a script,
 * or a curl can all POST here, and "the UI validates it" is not validation.
 */
function validateAnswer(
  fields: HumanInputField[],
  values: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === '') {
      if (!field.optional) problems.push(`${field.key} is required`);
      continue;
    }
    if (field.type === 'number' && typeof value !== 'number') {
      problems.push(`${field.key} must be a number`);
      continue;
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') {
      problems.push(`${field.key} must be true or false`);
      continue;
    }
    // Anchored, by the shared `matches` rule: an unanchored `\d{6}` would
    // accept a 6-digit substring of something longer — wrong for an OTP.
    if (field.pattern && !applyPredicate('matches', value, field.pattern)) {
      problems.push(`${field.key} does not match the expected format`);
    }
  }
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) problems.push(`unexpected field: ${key}`);
  }
  return problems;
}
