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
  /** Stable tag written onto each record from this endpoint. */
  id: z.string().min(1),
  recordsPath: z.string().default(''),
}));

const configSchema = z.object({
  endpoints: z.array(endpointSchema).min(1).max(64),
  /**
   * Max parallel in-flight requests. `0` / omitted = all endpoints at once
   * (Promise.all semantics).
   */
  concurrency: z.number().int().min(0).max(64).default(0),
  /** Field stamped on every record naming which endpoint produced it. */
  tagField: z.string().min(1).default('_endpoint'),
  /**
   * `fail` — any endpoint error fails the pipe (default, true wait-for-all).
   * `skip` — drop that endpoint's rows and continue with the rest.
   */
  onError: z.enum(['fail', 'skip']).default('fail'),
  batchSize: z.number().int().min(1).max(100_000).default(1_000),
});

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
      palette: 'advanced',
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
    const config = configSchema.parse(context.pipe.config);
    const ids = config.endpoints.map((endpoint) => endpoint.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('HTTP multi endpoints must have unique ids');
    }

    const triggerPayload =
      context.invocation?.payload &&
      typeof context.invocation.payload === 'object' &&
      !Array.isArray(context.invocation.payload)
        ? (context.invocation.payload as Record<string, unknown>)
        : { payload: context.invocation?.payload };

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

async function fetchAllEndpoints(options: {
  config: MultiConfig;
  context: PipeContext;
  triggerPayload: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>[]> {
  const { config, context, triggerPayload, fetchImpl } = options;
  const limit =
    config.concurrency > 0
      ? config.concurrency
      : config.endpoints.length;
  const results: Array<Record<string, unknown>[] | null> = new Array(
    config.endpoints.length,
  ).fill(null);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, config.endpoints.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= config.endpoints.length) return;
        const endpoint = config.endpoints[index]!;
        try {
          results[index] = await fetchOneEndpoint({
            endpoint,
            config,
            context,
            triggerPayload,
            fetchImpl,
          });
        } catch (error) {
          if (config.onError === 'skip') {
            results[index] = [];
            continue;
          }
          throw error;
        }
      }
    },
  );

  await Promise.all(workers);
  return results.flatMap((rows) => rows ?? []);
}

async function fetchOneEndpoint(options: {
  endpoint: EndpointConfig;
  config: MultiConfig;
  context: PipeContext;
  triggerPayload: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>[]> {
  const { endpoint, config, context, triggerPayload, fetchImpl } = options;
  const authCredentialId = requestCredentialId(endpoint.auth, context);
  const secret = await revealPipeSecret(context, authCredentialId);

  const result = await executeHttpRequest({
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
    signal: context.signal,
  });
  if (!result.ok) {
    throw new Error(
      `HTTP multi endpoint "${endpoint.id}" ${describeHttpFailure(result)}`,
    );
  }

  const selected = endpoint.recordsPath
    ? getPath(result.body, endpoint.recordsPath)
    : result.body;
  return normalizeRecords(selected, endpoint.id).map((record) => ({
    ...record,
    [config.tagField]: endpoint.id,
  }));
}

function normalizeRecords(
  selected: unknown,
  endpointId: string,
): Record<string, unknown>[] {
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
  throw new Error(
    `HTTP multi endpoint "${endpointId}" recordsPath must resolve to an object or array`,
  );
}
