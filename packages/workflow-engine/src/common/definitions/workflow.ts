/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/common/src/definitions/workflow.ts).
 */
import { TRIGGER_KINDS, type TriggerKind } from '@foxschema/workflow-contract';
import { CronExpressionParser } from 'cron-parser';
import { conditionsSchema } from './conditions.js';
import { isValidJsonSchema } from './io-schema.js';
import { z } from 'zod';
import {
  coerceHttpRequest,
  httpRequestSchema,
} from './http-request.js';
import {
  assertPipelineGraph,
  parsePipeline,
  pipelineSchema,
  type PipelineDef,
} from './pipeline.js';

// The workflow is the orchestration layer of the workflow > pipeline > pipe
// hierarchy: the unit of triggering, versioning, and run records. It sequences
// whole pipelines with completion edges (pipeline B starts when A finishes) —
// control flow at completion granularity, while pipelines stream batches
// internally.

const triggerCommon = {
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  /**
   * All must pass before a run is created. Evaluated at admission, which is
   * the one place every trigger kind funnels through — so "only run when…"
   * means the same thing for a schedule, a webhook and a parent call.
   */
  conditions: conditionsSchema,
};

// Exponential-backoff retry policy (Cloud Scheduler-style). Durations are
// strings with a unit suffix, e.g. "5s", "1h".
const durationField = z
  .string()
  .refine(validDuration, { message: 'invalid duration (e.g. "5s", "1h")' });

export const retryConfigSchema = z.object({
  maxRetryAttempts: z.number().int().min(0).max(100).default(0),
  maxRetryDuration: durationField.default('0s'),
  minBackoffDuration: durationField.default('5s'),
  maxBackoffDuration: durationField.default('1h'),
  maxDoublings: z.number().int().min(0).max(20).default(5),
});

/**
 * Webhook defaults declared as values, not only as zod `.default()` calls:
 * `liftWebhookAuth` has to apply the same ones to stored documents that never
 * pass through the schema, and two hand-copied lists would drift.
 */
export const WEBHOOK_DEFAULT_METHODS = ['POST'] as const;
export const WEBHOOK_DEFAULT_ON_MISSING_KEY = 'reject' as const;

/** JWT algorithms this build verifies, all via node:crypto — no dependency. */
export const JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
] as const;

/**
 * How a webhook request proves it may start the workflow.
 *
 * Each member carries only the settings its own method uses. The alternative —
 * one flat bag with every field optional — was rejected for the same reason
 * the trigger union itself was: a `maxAgeSeconds` sitting on a Basic-auth
 * webhook reads as a setting that does something.
 */
export const webhookAuthSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('none'),
    /**
     * Required, and required to be `true`. An unauthenticated webhook lets
     * anyone who learns the URL start runs and spend whatever the workflow
     * spends, so it should not be reachable by leaving a field blank. Saying
     * it out loud is the point.
     */
    acknowledgeUnauthenticated: z.literal(true),
  }),
  z.object({
    type: z.literal('signature'),
    /** Credential holding the shared secret used to verify signatures. */
    credentialId: z.string().min(1),
    signatureHeader: z.string().min(1).default('x-foxflow-signature'),
    timestampHeader: z.string().min(1).default('x-foxflow-timestamp'),
    maxAgeSeconds: z.number().int().positive().max(3600).default(300),
  }),
  z.object({
    type: z.literal('basic'),
    /** Credential holding `username` and `password`. */
    credentialId: z.string().min(1),
  }),
  z.object({
    type: z.literal('header'),
    /** Credential holding the expected value as `token`/`apiKey`/`secret`. */
    credentialId: z.string().min(1),
    header: z.string().min(1).default('authorization'),
  }),
  z.object({
    type: z.literal('jwt'),
    /** Credential holding `secret` (HS*) or `publicKey` (RS*). */
    credentialId: z.string().min(1),
    header: z.string().min(1).default('authorization'),
    /**
     * Accepted algorithms, pinned here rather than read from the token.
     * Trusting the token's own `alg` is the classic JWT forgery: a caller
     * flips RS256 to HS256 and signs with the public key as the HMAC secret.
     */
    algorithms: z.array(z.enum(JWT_ALGORITHMS)).min(1).default(['HS256']),
    issuer: z.string().min(1).optional(),
    audience: z.string().min(1).optional(),
    clockToleranceSeconds: z.number().int().min(0).max(300).default(60),
  }),
]);
export type WebhookAuth = z.infer<typeof webhookAuthSchema>;

// How a workflow is activated. These bindings live at workflow level; source
// pipes decide how a run obtains records after activation.
export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({
    ...triggerCommon,
    kind: z.literal('manual'),
    // Pre-start parameters for debugging/testing: when set, a manual run is
    // invoked with this as its payload, so source pipes receive it as records
    // instead of the synthetic "triggered" record.
    inputData: z.unknown().optional(),
  }),
  z.object({
    ...triggerCommon,
    kind: z.literal('cron'),
    cron: z
      .string()
      .min(1)
      .refine(validCron, { message: 'invalid cron expression' }),
    timezone: z
      .string()
      .refine(validTimezone, { message: 'invalid IANA timezone' })
      .default('UTC'),
    catchUp: z.enum(['none', 'one', 'all']).default('none'),
    // What firing this schedule does: run this workflow (default) or call an
    // external HTTP endpoint.
    executionType: z.enum(['workflow', 'http']).default('workflow'),
    /**
     * Outbound request when `executionType === 'http'`. Same shape as
     * `source.api.http` (shared `httpRequestSchema`) — no duplicate fields.
     */
    http: httpRequestSchema.optional(),
    // Optional exponential-backoff retry policy for a failed job. Absent means
    // no retry configuration on the schedule. Durations are strings like
    // "5s" / "1h"; "0s" for max retry duration means unlimited.
    retryConfig: retryConfigSchema.optional(),
  }),
  z.object({
    ...triggerCommon,
    kind: z.literal('webhook'),
    /**
     * How a caller proves it may start this workflow. A union rather than flat
     * fields so `signatureHeader` cannot sit there looking meaningful on a
     * trigger authenticating with Basic.
     */
    auth: webhookAuthSchema,
    /**
     * Methods this endpoint answers. Anything else gets 405. POST-only by
     * default — a webhook that also answers GET is a webhook someone can fire
     * from a browser address bar by accident.
     */
    methods: z
      .array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']))
      .min(1)
      .max(5)
      .default([...WEBHOOK_DEFAULT_METHODS]),
    /**
     * Optional vanity path, served at `/api/hooks/<path>` alongside the
     * canonical `/api/triggers/<workflowId>/<triggerId>`. For providers whose
     * URL field is short, or where the workflow id would leak more than you
     * want. Slashes are allowed inside; leading and trailing ones are not.
     */
    path: z
      .string()
      .min(1)
      .max(128)
      .regex(
        // eslint-disable-next-line security/detect-unsafe-regex -- false positive: every repeated segment starts with a literal '/', so matching is linear; zod also caps the path at 128 characters
        /^[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/,
        'path may contain letters, digits, . _ ~ - and internal slashes',
      )
      .optional(),
    idempotencyHeader: z.string().min(1).default('x-idempotency-key'),
    /**
     * What to do when the request carries no idempotency header. 'reject'
     * (default) keeps the original contract. 'fingerprint' derives the key
     * from the request itself, for the many providers that cannot send one —
     * weaker, because a genuine duplicate submission is indistinguishable
     * from a retry, but it is the difference between usable and not.
     */
    onMissingIdempotencyKey: z
      .enum(['reject', 'fingerprint'])
      .default(WEBHOOK_DEFAULT_ON_MISSING_KEY),
    maxBodyBytes: z.number().int().positive().max(1_048_576).default(1_048_576),
  }),
  z.object({
    ...triggerCommon,
    kind: z.literal('http'),
    credentialId: z.string().min(1),
    authHeader: z.string().min(1).default('authorization'),
    idempotencyHeader: z.string().min(1).default('x-idempotency-key'),
    maxBodyBytes: z.number().int().positive().max(1_048_576).default(1_048_576),
    requiredFields: z.array(z.string().min(1)).max(100).default([]),
  }),
  z.object({
    ...triggerCommon,
    kind: z.literal('poll'),
    /**
     * How often to call the endpoint. Floored at 10s: this is a courtesy to
     * the API on the other end, which is usually someone else's.
     */
    intervalSeconds: z.number().int().min(10).max(86_400).default(300),
    /** The request to make. Same shape as `source.api.http` and cron's `http`. */
    http: httpRequestSchema,
    /**
     * Dot path to the array of items in the response body. Empty means the
     * body *is* the array. A path that misses, or lands on a non-array, is an
     * error rather than "zero items" — silently polling nothing forever is the
     * worst failure mode this trigger has.
     */
    resultsPath: z.string().default(''),
    /**
     * Field on each item that identifies it across polls. Items whose key was
     * seen on a previous poll are dropped, so a run is created only for new
     * ones — and not created at all when everything is old.
     */
    dedupKey: z.string().min(1),
    /** Most items to carry into one invocation. Extras wait for the next poll. */
    maxItems: z.number().int().positive().max(1000).default(100),
    /**
     * What the very first poll does, before any cursor exists. 'prime' records
     * what is already there and creates no run — the usual intent, since the
     * endpoint's whole backlog is rarely what you meant by "when something new
     * arrives". 'fire' treats the entire first response as new.
     */
    onFirstPoll: z.enum(['prime', 'fire']).default('prime'),
  }),
  z.object({
    ...triggerCommon,
    kind: z.literal('parent'),
    /**
     * Optional allowlist of parent workflow ids that may call this workflow
     * via `workflow.sub`. Empty/omitted means any parent may call.
     */
    allowFrom: z.array(z.string().min(1)).max(200).default([]),
  }),
]);
export type TriggerDef = z.infer<typeof triggerSchema>;

/**
 * The trigger kinds, as a value — for zod enums and UI lists that need to
 * enumerate them rather than just accept one.
 *
 * The assertion below is the point: hand-maintained copies of this list had
 * drifted, still offering `event` and `custom` after both kinds were deleted.
 * Anything that adds or removes a kind now fails to compile until this array
 * matches.
 */
// The list itself lives in the contract package, so the browser can read it
// without this module's schemas.
export { TRIGGER_KINDS, type TriggerKind };

type AssertKindsMatch = [TriggerDef['kind']] extends [TriggerKind]
  ? [TriggerKind] extends [TriggerDef['kind']]
    ? true
    : ['TRIGGER_KINDS has a kind the schema does not']
  : ['triggerSchema has a kind TRIGGER_KINDS is missing'];
const _assertKindsMatch: AssertKindsMatch = true;
void _assertKindsMatch;

// When a trigger fires while a run of the same workflow is active.
export const overlapPolicySchema = z
  .enum(['skip', 'queue', 'parallel'])
  .default('skip');

// A completion edge between two pipelines, with per-edge settings:
// - `on` — which terminal state of `from` releases `to`: 'success' (default),
//   'failure' (compensation/cleanup paths), or 'always'. When `to` is not
//   released it finishes as `skipped`, not `failed`.
// - `gate` — optional run-gate expression evaluated exactly once at this
//   barrier against the run context (trigger payload, upstream stats); false
//   marks `to` as `skipped`. The expression language ships with the executor;
//   at definition level it is an opaque string.
export const dependencySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  on: z.enum(['success', 'failure', 'always']).default('success'),
  gate: z.string().min(1).optional(),
});
export type DependencyDef = z.infer<typeof dependencySchema>;

// User-authored JSON Schema (input/output contracts). Validity is checked with
// ajv at parse time so a broken schema fails at save, not at first run.
const jsonSchemaField = z
  .record(z.string(), z.unknown())
  .refine(isValidJsonSchema, { message: 'must be a valid JSON Schema' });

// Middleware is referenced by name (registered in the engine's Middleware
// Registry), never by function — definitions are durable and snapshotted, so
// closures cannot be persisted. A bare string is sugar for { name, config: {} }.
const middlewareRefSchema = z.union([
  z
    .string()
    .min(1)
    .transform((name) => ({ name, config: {} as Record<string, unknown> })),
  z.object({
    name: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
]);
export type MiddlewareRef = z.infer<typeof middlewareRefSchema>;

const normalizedWorkflowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    /**
     * Why this workflow exists — agent/human retrieval signal (Agentic OS).
     * Prefer this over scraping pipe configs to understand intent.
     */
    purpose: z.string().max(2000).optional(),
    /** Free-form labels for catalog search and reuse discovery. */
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
    /**
     * Short prose of the expected outcome. Hard contract remains `outputSchema`.
     */
    expectedResult: z.string().max(2000).optional(),
    version: z.number().int().min(1).default(1),
    /**
     * Where this workflow came from. `authored` means a human wrote it here;
     * anything else arrived from outside — an n8n export, a shared package, or
     * a proposal an agent generated.
     *
     * It exists so privileged capabilities can be withheld from workflows
     * nobody reviewed. A workflow is data, and data that arrives from elsewhere
     * should not be able to reach for the same powers as one somebody typed.
     * Defaults to `authored` because that is what every existing stored
     * workflow is, and a default of "untrusted" would revoke capability from
     * workflows that already have it.
     */
    origin: z
      .enum(['authored', 'imported', 'proposed'])
      .default('authored'),
    pipelines: z.array(pipelineSchema).min(1),
    dependencies: z.array(dependencySchema).default([]),
    triggers: z.array(triggerSchema).default([
      { id: 'manual', kind: 'manual', enabled: true },
    ]),
    onOverlap: overlapPolicySchema,
    /** Named middleware applied at the engine/workflow/pipeline tiers, in order. */
    middleware: z.array(middlewareRefSchema).default([]),
    /**
     * Workflow to run when a run of this one fails.
     *
     * Failure handling today is per-pipe (`onError`, `rejects` ports) or
     * after the fact, by a human reading the run list. This is the missing
     * whole-run answer: page someone, file a ticket, roll something back.
     *
     * The handler is dispatched, not awaited — the failed run is already
     * finished, and blocking it on a handler would make one failure two.
     */
    errorHandler: z
      .object({
        workflowId: z.string().min(1),
        /** Pin to a stored version, like `workflow.sub`. */
        workflowVersion: z.number().int().min(1).optional(),
      })
      .optional(),
    /**
     * Contract for the run input payload (manual `inputData`, webhook/HTTP
     * bodies, sub-workflow call payloads). Enforced at admission; cron's
     * engine-generated payload is exempt.
     */
    inputSchema: jsonSchemaField.optional(),
    /**
     * Declared contract for workflow output. Declarative until Phase 5 gives
     * workflows synchronous outputs to validate.
     */
    outputSchema: jsonSchemaField.optional(),
  })
  .superRefine((workflow, ctx) => {
    workflow.triggers.forEach((trigger, index) => {
      if (
        trigger.kind === 'cron' &&
        trigger.executionType === 'http' &&
        !trigger.http
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['triggers', index, 'http'],
          message:
            'http request config is required when executionType is http',
        });
      }
    });
  });

export const workflowSchema = z.preprocess(
  normalizeWorkflowTriggers,
  normalizedWorkflowSchema,
);
export type WorkflowDef = z.infer<typeof workflowSchema>;

function normalizeWorkflowTriggers(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input;
  const workflow = input as Record<string, unknown>;
  if (!Array.isArray(workflow.triggers)) return input;

  const used = new Set<string>();
  const triggers = workflow.triggers.map((value, index) => {
    if (value === null || typeof value !== 'object') return value;
    const trigger = value as Record<string, unknown>;
    const kind = trigger.kind === 'schedule' ? 'cron' : trigger.kind;
    const explicitId =
      typeof trigger.id === 'string' && trigger.id.length > 0
        ? trigger.id
        : undefined;
    let id = explicitId ?? String(kind ?? `trigger-${index + 1}`);
    if (!explicitId) {
      let suffix = 2;
      while (used.has(id)) id = `${String(kind)}-${suffix++}`;
    }
    used.add(id);
    const next: Record<string, unknown> = { ...trigger, id, kind };
    // Coerce legacy/flat HTTP request shapes onto cron.http before zod parse.
    if (kind === 'cron' && next.http !== undefined) {
      next.http = coerceHttpRequest(next.http);
    }
    return next;
  });
  return { ...workflow, triggers };
}

function validCron(value: string): boolean {
  try {
    CronExpressionParser.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// A non-negative duration with a unit suffix: seconds, minutes, hours, or days.
function validDuration(value: string): boolean {
  return parseDurationMs(value.trim()) !== undefined;
}

const DURATION_UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Milliseconds in a duration such as `500ms`, `1.5s`, `5m`, `1h` or `1d`;
 * `undefined` when it is not one. Validation and the scheduler both read
 * durations through this, so a value that saves is a value that runs.
 */
export function parseDurationMs(value: string): number | undefined {
  // eslint-disable-next-line security/detect-unsafe-regex -- false positive: anchored; one optional fraction and a fixed unit, no overlapping repetition
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) return undefined;
  return Math.round(Number(match[1]) * DURATION_UNIT_MS[match[2] as keyof typeof DURATION_UNIT_MS]);
}

/**
 * Every shape-compatibility lift, in one place.
 *
 * Applied by `parseWorkflow` *and* by the storage layer on read: a workflow
 * saved before a shape changed sits in SQLite as raw JSON that nothing
 * re-validates, so normalizing only on the way in would leave existing rows
 * broken forever. Each lift returns its input unchanged when there is nothing
 * to do, so this is cheap enough to run on every read.
 */
export function normalizeWorkflowDocument(input: unknown): unknown {
  return liftWebhookAuth(liftDependsOn(input));
}

/**
 * Webhook triggers used to carry their signature settings flat —
 * `credentialId`, `signatureHeader`, `timestampHeader`, `maxAgeSeconds` — from
 * before there was more than one way to authenticate one. Lift that shape into
 * `auth: { type: 'signature', … }` so documents saved then still parse now.
 *
 * A document that already has `auth` is left alone, which keeps re-parsing
 * idempotent. Only the keys that moved are stripped; `idempotencyHeader` and
 * `maxBodyBytes` stayed where they were.
 */
export function liftWebhookAuth(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || !('triggers' in input)) {
    return input;
  }
  const doc = input as Record<string, unknown>;
  if (!Array.isArray(doc.triggers)) return input;

  let changed = false;
  const triggers = doc.triggers.map((entry) => {
    if (entry === null || typeof entry !== 'object') return entry;
    const trigger = entry as Record<string, unknown>;
    if (trigger.kind !== 'webhook') return entry;

    let next = trigger;

    // Signature settings used to sit flat on the trigger, from before there
    // was more than one way to authenticate one.
    if (!('auth' in trigger) && trigger.credentialId !== undefined) {
      const {
        credentialId,
        signatureHeader,
        timestampHeader,
        maxAgeSeconds,
        ...rest
      } = trigger;
      next = {
        ...rest,
        auth: {
          type: 'signature',
          credentialId,
          ...(signatureHeader === undefined ? {} : { signatureHeader }),
          ...(timestampHeader === undefined ? {} : { timestampHeader }),
          ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
        },
      };
    }

    // Fields added alongside `auth`. Defaults matter here and not only in the
    // schema: stored documents are read back without being re-validated, so
    // zod never runs on them and an absent `methods` would reach the router.
    if (next.methods === undefined) {
      next = { ...next, methods: [...WEBHOOK_DEFAULT_METHODS] };
    }
    if (next.onMissingIdempotencyKey === undefined) {
      next = {
        ...next,
        onMissingIdempotencyKey: WEBHOOK_DEFAULT_ON_MISSING_KEY,
      };
    }

    if (next === trigger) return entry;
    changed = true;
    return next;
  });

  return changed ? { ...doc, triggers } : input;
}

/**
 * Authoring sugar: a pipeline entry inside a workflow document may declare
 * `dependsOn: ["load"]` or `dependsOn: [{ pipeline: "load", on: "failure",
 * gate: "..." }]` instead of (or alongside) the workflow-level `dependencies`
 * list. Normalization lifts every entry into the canonical `dependencies`
 * array and strips `dependsOn`, so the parsed document has one source of
 * truth and re-parsing it is idempotent.
 */
function liftDependsOn(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || !('pipelines' in input)) {
    return input;
  }
  const doc = input as Record<string, unknown>;
  if (!Array.isArray(doc.pipelines)) return input;

  const lifted: unknown[] = [];
  const pipelines = doc.pipelines.map((entry) => {
    if (entry === null || typeof entry !== 'object' || !('dependsOn' in entry)) {
      return entry;
    }
    const { dependsOn, ...pipeline } = entry as Record<string, unknown>;
    if (Array.isArray(dependsOn)) {
      for (const dep of dependsOn) {
        if (typeof dep === 'string') {
          lifted.push({ from: dep, to: pipeline.id });
        } else if (dep !== null && typeof dep === 'object') {
          const { pipeline: from, ...settings } = dep as Record<string, unknown>;
          lifted.push({ ...settings, from, to: pipeline.id });
        } else {
          // Malformed entry — surface it through zod's dependency validation.
          lifted.push({ from: dep, to: pipeline.id });
        }
      }
    }
    return pipeline;
  });

  const existing = Array.isArray(doc.dependencies) ? doc.dependencies : [];
  return { ...doc, pipelines, dependencies: [...existing, ...lifted] };
}

/**
 * Parse and structurally validate a workflow definition: zod shape checks
 * (after `dependsOn` sugar is lifted into `dependencies`), unique pipeline
 * ids, dependencies referencing real pipelines exactly once per (from, to)
 * pair, and each pipeline's own pipe-graph integrity. (Cycle detection at
 * both levels happens in planWorkflow / planExecution.) Throws a ZodError on
 * shape problems and a plain Error on graph problems.
 */
export function parseWorkflow(input: unknown): WorkflowDef {
  const workflow = workflowSchema.parse(normalizeWorkflowDocument(input));
  const ids = new Set<string>();
  for (const pipeline of workflow.pipelines) {
    if (ids.has(pipeline.id)) {
      throw new Error(`duplicate pipeline id: ${pipeline.id}`);
    }
    ids.add(pipeline.id);
    assertPipelineGraph(pipeline);
  }
  const seen = new Set<string>();
  const triggerIds = new Set<string>();
  for (const trigger of workflow.triggers) {
    if (triggerIds.has(trigger.id)) {
      throw new Error(`duplicate trigger id: ${trigger.id}`);
    }
    triggerIds.add(trigger.id);
  }
  for (const dep of workflow.dependencies) {
    if (!ids.has(dep.from)) {
      throw new Error(
        `dependency references unknown source pipeline: ${dep.from}`,
      );
    }
    if (!ids.has(dep.to)) {
      throw new Error(
        `dependency references unknown target pipeline: ${dep.to}`,
      );
    }
    const key = `${dep.from}\0${dep.to}`;
    if (seen.has(key)) {
      throw new Error(`duplicate dependency: ${dep.from} -> ${dep.to}`);
    }
    seen.add(key);
  }
  return workflow;
}

/**
 * Wrap a standalone pipeline in a single-pipeline workflow. This keeps the
 * common case frictionless: users define just a pipeline (YAML or GUI) and
 * never meet the workflow layer until they need chaining, gates, or triggers.
 */
export function workflowFromPipeline(pipeline: PipelineDef): WorkflowDef {
  return workflowSchema.parse({
    id: pipeline.id,
    name: pipeline.name,
    pipelines: [pipeline],
  });
}

/**
 * Accept either a full workflow document or a bare pipeline document
 * (distinguished by `pipelines` vs `pipes`) and return a validated workflow —
 * the API/CLI entry point that makes single-pipeline definitions implicit.
 */
export function parseWorkflowInput(input: unknown): WorkflowDef {
  if (input !== null && typeof input === 'object' && 'pipelines' in input) {
    return parseWorkflow(input);
  }
  return workflowFromPipeline(parsePipeline(input));
}
