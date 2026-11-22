/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/http/src/multi-http.ts).
 */
import { z } from 'zod';
import {
  coerceHttpRequest,
  httpRequestJsonSchema,
  httpRequestSchema,
  getPath,
} from '../../common/index.js';
import type {
  PipeContext,
  RecordBatch,
  SourcePipe,
} from '../../registry/index.js';
import { definePipeMetadata, type PipeMetadata } from '../../sdk/index.js';
import { requestCredentialId, revealPipeSecret } from '../pipe-context.js';
import { executeHttpRequest, describeHttpFailure } from './request.js';

const endpointSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const request = coerceHttpRequest(raw.request ?? raw);
  return {
    id: raw.id,
    ...(typeof request === 'object' && request ? request : {}),
    recordsPath: raw.recordsPath ?? '',
  };
}, httpRequestSchema.extend({
  /**
   * Stable tag written onto each record from this endpoint. Trimmed, so
   * `tokyo` and `tokyo ` are one id (as the designer treats them) and a
   * blank id is rejected.
   */
  id: z.string().trim().min(1),
  recordsPath: z.string().default(''),
}));

const configSchema = z
  .object({
    endpoints: z.array(endpointSchema).min(1).max(64),
    /**
     * Default naming convention for endpoint responses:
     * - `output`: output1, output2, ...
     * - `resp`: resp1, resp2, ...
     */
    responseNaming: z.enum(['output', 'resp']).default('output').optional(),
    /**
     * Execution mode:
     * - `parallel`: all endpoints run concurrently (or up to `concurrency`).
     * - `linear`: endpoints run sequentially one after another in order.
     */
    executionMode: z.enum(['parallel', 'linear']).default('parallel'),
    /**
     * Output mode:
     * - `records`: extracts rows from each endpoint and emits a flattened stream of records.
     * - `merge`: merges all endpoint responses into a single record `{ [id]: payload }` for script transformation.
     */
    outputMode: z.enum(['records', 'merge']).default('records'),
    /**
     * Max parallel in-flight requests when executionMode is parallel.
     * `0` / omitted = all endpoints at once (Promise.all semantics).
     */
    concurrency: z.number().int().min(0).max(64).default(0),
    /** Field stamped on every record naming which endpoint produced it (records mode only). */
    tagField: z.string().min(1).default('_endpoint'),
    /**
     * `fail` — any endpoint error fails the pipe (default, stop to failure).
     * `skip` — drop that endpoint's rows or record error object in merged payload and continue with the rest.
     */
    onError: z.enum(['fail', 'skip']).default('fail'),
    batchSize: z.number().int().min(1).max(100_000).default(1_000),
  })
  .refine(
    (data) => {
      const ids = data.endpoints.map((endpoint) => endpoint.id);
      return new Set(ids).size === ids.length;
    },
    { message: 'HTTP multi endpoints must have unique ids', path: ['endpoints'] },
  );

type EndpointConfig = z.infer<typeof endpointSchema>;
type MultiConfig = z.infer<typeof configSchema>;

/**
 * Fan-out HTTP source: fires every configured endpoint (optionally capped),
 * waits for all to finish, then emits tagged records as one stream.
 */
export class MultiHttpSourcePipe implements SourcePipe {
  readonly type = 'source.api.http.multi';
  readonly role = 'source';

  constructor(private readonly request?: typeof fetch) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'HTTP Multi',
      category: 'Source/API',
      family: 'http',
      tags: ['auth', 'api', 'fan-out', 'google'],
      palette: 'primary',
      version: '0.2.0',
      role: 'source',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: {
        type: 'object',
        required: ['endpoints'],
        properties: {
          endpoints: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: {
              type: 'object',
              required: ['id', 'url'],
              properties: {
                id: { type: 'string' },
                recordsPath: { type: 'string', default: '' },
                ...httpRequestJsonSchema.properties,
              },
            },
          },
          responseNaming: {
            type: 'string',
            enum: ['output', 'resp'],
            default: 'output',
          },
          executionMode: {
            type: 'string',
            enum: ['parallel', 'linear'],
            default: 'parallel',
          },
          outputMode: {
            type: 'string',
            enum: ['records', 'merge'],
            default: 'records',
          },
          concurrency: {
            type: 'integer',
            minimum: 0,
            maximum: 64,
            default: 0,
          },
          tagField: { type: 'string', default: '_endpoint' },
          onError: {
            type: 'string',
            enum: ['fail', 'skip'],
            default: 'fail',
          },
          batchSize: {
            type: 'integer',
            minimum: 1,
            maximum: 100_000,
            default: 1_000,
          },
        },
      },
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    configSchema.parse(config);
  }

  async *read(context: PipeContext): AsyncIterable<RecordBatch> {
    // Unique ids are enforced by the schema refine.
    const config = configSchema.parse(context.pipe.config);

    const triggerPayload =
      context.invocation?.payload &&
      typeof context.invocation.payload === 'object' &&
      !Array.isArray(context.invocation.payload)
        ? (context.invocation.payload as Record<string, unknown>)
        : { payload: context.invocation?.payload };

    if (config.outputMode === 'merge') {
      // One record: a checkpoint past it means it was already delivered.
      if (Number(context.checkpoint?.cursor.offset ?? 0) >= 1) return;
      const merged = await fetchAllEndpointsMerged({
        config,
        context,
        triggerPayload,
        fetchImpl: this.request,
      });
      yield {
        id: `${context.pipe.id}:0:0-0`,
        partitionId: '0',
        records: [merged],
        cursor: { offset: 1 },
      };
      return;
    }

    const rows = await fetchAllEndpoints({
      config,
      context,
      triggerPayload,
      fetchImpl: this.request,
    });

    const resumeAfter = Number(context.checkpoint?.cursor.offset ?? 0);
    for (
      let offset = resumeAfter;
      offset < rows.length;
      offset += config.batchSize
    ) {
      const end = Math.min(offset + config.batchSize, rows.length);
      yield {
        id: `${context.pipe.id}:0:${offset}-${end - 1}`,
        partitionId: '0',
        records: rows.slice(offset, end),
        cursor: { offset: end },
      };
    }
  }
}

type FetchOptions = {
  config: MultiConfig;
  context: PipeContext;
  triggerPayload: Record<string, unknown>;
  fetchImpl?: typeof fetch;
};

/**
 * Runs `work` for every endpoint, `linear` one at a time or `parallel` up to
 * `concurrency`, and returns the results in endpoint order. A failed endpoint
 * fails the pipe, or with `onError: skip` becomes `onSkip(error, endpoint)`.
 *
 * On a fail-fast error the shared signal is aborted, so requests already in
 * flight are cancelled too — not only the ones still queued. With the default
 * `concurrency: 0` every endpoint is in flight from the start, so stopping the
 * queue alone would change nothing.
 */
async function forEachEndpoint<T>(
  config: MultiConfig,
  parentSignal: AbortSignal | undefined,
  work: (endpoint: EndpointConfig, signal: AbortSignal) => Promise<T>,
  onSkip: (error: unknown, endpoint: EndpointConfig) => T,
): Promise<T[]> {
  const limit =
    config.executionMode === 'linear'
      ? 1
      : config.concurrency > 0
        ? config.concurrency
        : config.endpoints.length;
  const results = new Array<T>(config.endpoints.length);
  let next = 0;
  let failed = false;

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort);

  const workers = Array.from(
    { length: Math.min(limit, config.endpoints.length) },
    async () => {
      while (!failed) {
        const index = next++;
        if (index >= config.endpoints.length) return;
        try {
          results[index] = await work(config.endpoints[index]!, controller.signal);
        } catch (error) {
          if (config.onError !== 'skip') {
            if (!failed) {
              failed = true;
              controller.abort(error);
            }
            throw error;
          }
          results[index] = onSkip(error, config.endpoints[index]!);
        }
      }
    },
  );

  try {
    await Promise.all(workers);
  } finally {
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
  return results;
}

async function fetchAllEndpoints(
  options: FetchOptions,
): Promise<Record<string, unknown>[]> {
  const { config } = options;
  const rows = await forEachEndpoint(
    config,
    options.context.signal,
    async (endpoint, signal) =>
      normalizeRecords(await fetchOneEndpoint(endpoint, options, signal), endpoint).map(
        (record) => ({ ...record, [config.tagField]: endpoint.id }),
      ),
    (error, endpoint) => {
      // Records mode has nowhere to put the failure, so the run's timeline
      // gets it; without this a skipped endpoint vanished and the run
      // reported a clean success.
      logSkip(options.context, endpoint, error);
      return [];
    },
  );
  return rows.flat();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSkip(context: PipeContext, endpoint: EndpointConfig, error: unknown): void {
  const message = errorText(error);
  // Every failure here already names the endpoint; say it once.
  const named = message.includes(`"${endpoint.id}"`) ? message : `HTTP multi endpoint "${endpoint.id}": ${message}`;
  context.infrastructure?.logger.warn(`${named} (skipped, onError: skip)`, { endpoint: endpoint.id });
}

/**
 * One record keyed by endpoint id, in endpoint order whatever order the
 * responses arrive in. `Object.fromEntries` defines own properties, so an id
 * such as `__proto__` is a key like any other.
 */
async function fetchAllEndpointsMerged(
  options: FetchOptions,
): Promise<Record<string, unknown>> {
  const { config } = options;
  const bodies = await forEachEndpoint<unknown>(
    config,
    options.context.signal,
    async (endpoint, signal) => {
      const selected = await fetchOneEndpoint(endpoint, options, signal);
      if (selected === undefined) {
        // JSON would drop the key without a word.
        throw new Error(`HTTP multi endpoint "${endpoint.id}" response is empty`);
      }
      return selected;
    },
    (error, endpoint) => {
      logSkip(options.context, endpoint, error);
      return { ok: false, error: errorText(error) };
    },
  );
  return Object.fromEntries(
    config.endpoints.map((endpoint, index) => [endpoint.id, bodies[index]]),
  );
}

/** One endpoint's response body, narrowed to `recordsPath` when set. */
async function fetchOneEndpoint(
  endpoint: EndpointConfig,
  { context, triggerPayload, fetchImpl }: FetchOptions,
  signal: AbortSignal,
): Promise<unknown> {
  const authCredentialId = requestCredentialId(endpoint.auth, context);
  const secret = await revealPipeSecret(context, authCredentialId);

  let result: Awaited<ReturnType<typeof executeHttpRequest>>;
  try {
    result = await executeHttpRequest({
      request: endpoint,
      secret,
      credentialId: authCredentialId,
      credentials: context.credentials,
      variables: { ...context.variables, ...endpoint.variables },
      trigger: {
        id: context.invocation?.triggerId,
        kind: context.invocation?.kind,
        ...triggerPayload,
      },
      fetch: fetchImpl,
      signal,
      onMissingTemplate: (paths) =>
        context.infrastructure?.logger.warn(
          `HTTP multi endpoint "${endpoint.id}": ${paths.map((p) => `{{${p}}}`).join(', ')} has no value, so it was sent empty`,
          { endpoint: endpoint.id, templates: paths },
        ),
    });
  } catch (error) {
    // Cancelled because a sibling failed (onError: fail) or the run stopped:
    // the real cause is reported elsewhere.
    if (signal.aborted) throw error;
    // No response at all (DNS, refused, TLS, a blocked address). Without the
    // id, "getaddrinfo ENOTFOUND …" does not say which of 64 endpoints it was.
    const cause = (error as { cause?: unknown } | null)?.cause;
    const detail = cause instanceof Error ? `${errorText(error)} (${cause.message})` : errorText(error);
    throw new Error(`HTTP multi endpoint "${endpoint.id}" request failed: ${detail}`, { cause: error });
  }
  if (!result.ok) {
    throw new Error(
      `HTTP multi endpoint "${endpoint.id}" ${describeHttpFailure(result)}`,
    );
  }

  if (!endpoint.recordsPath) return result.body;
  const selected = getPath(result.body, endpoint.recordsPath);
  if (selected === undefined) {
    // A typo in recordsPath, in either output mode.
    throw new Error(
      `HTTP multi endpoint "${endpoint.id}" recordsPath "${endpoint.recordsPath}" matched nothing in the response`,
    );
  }
  return selected;
}

function normalizeRecords(
  selected: unknown,
  endpoint: EndpointConfig,
): Record<string, unknown>[] {
  const endpointId = endpoint.id;
  if (selected == null) {
    throw new Error(`HTTP multi endpoint "${endpointId}" response is empty`);
  }
  if (Array.isArray(selected)) {
    return selected.map((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(
          `HTTP multi endpoint "${endpointId}" records[${index}] must be a JSON object`,
        );
      }
      return record as Record<string, unknown>;
    });
  }
  if (typeof selected === 'object') {
    return [selected as Record<string, unknown>];
  }
  if (!endpoint.recordsPath && typeof selected === 'string') {
    // The body was not JSON (an HTML page, plain text): there is no recordsPath to blame.
    throw new Error(
      `HTTP multi endpoint "${endpointId}" returned text, not JSON; records mode needs a JSON object or array (merge mode keeps text as-is)`,
    );
  }
  throw new Error(
    `HTTP multi endpoint "${endpointId}" recordsPath must resolve to an object or array`,
  );
}
