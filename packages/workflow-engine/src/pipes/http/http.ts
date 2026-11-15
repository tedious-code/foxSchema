/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/http/src/http.ts).
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

const sourceExtrasSchema = z.object({
  recordsPath: z.string().default(''),
  batchSize: z.number().int().min(1).max(100_000).default(1_000),
});

/** Pipe config = shared HTTP request + source-only fields. */
const configSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = input as Record<string, unknown>;
  const request = coerceHttpRequest(raw.request ?? raw);
  return {
    ...(typeof request === 'object' && request ? request : {}),
    recordsPath: raw.recordsPath ?? '',
    batchSize: raw.batchSize ?? 1_000,
  };
}, httpRequestSchema.merge(sourceExtrasSchema));

export class HttpSourcePipe implements SourcePipe {
  readonly type = 'source.api.http';
  readonly role = 'source';

  constructor(private readonly request?: typeof fetch) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'HTTP API',
      category: 'Source/API',
      family: 'http',
      tags: ['auth', 'api', 'oauth'],
      version: '0.3.0',
      role: 'source',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: {
        type: 'object',
        required: ['url'],
        properties: {
          ...httpRequestJsonSchema.properties,
          recordsPath: { type: 'string', default: '' },
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
    const authCredentialId = requestCredentialId(config.auth, context);
    const secret = await revealPipeSecret(context, authCredentialId);

    const triggerPayload =
      context.invocation?.payload &&
      typeof context.invocation.payload === 'object' &&
      !Array.isArray(context.invocation.payload)
        ? (context.invocation.payload as Record<string, unknown>)
        : { payload: context.invocation?.payload };

    const result = await executeHttpRequest({
      request: config,
      secret,
      credentialId: authCredentialId,
      credentials: context.credentials,
      // Environment variables (global then workflow-local) are the base;
      // pipe-local `variables` are the most specific and override them.
      variables: { ...context.variables, ...config.variables },
      trigger: {
        id: context.invocation?.triggerId,
        kind: context.invocation?.kind,
        ...triggerPayload,
      },
      fetch: this.request,
      signal: context.signal,
    });
    if (!result.ok) {
      throw new Error(`HTTP source ${describeHttpFailure(result)}`);
    }

    const selected = config.recordsPath
      ? getPath(result.body, config.recordsPath)
      : result.body;
    const rows = normalizeRecords(selected);
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

function normalizeRecords(selected: unknown): Record<string, unknown>[] {
  if (selected == null) {
    throw new Error('HTTP source response is empty');
  }
  if (Array.isArray(selected)) {
    return selected.map((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(
          `HTTP source records[${index}] must be a JSON object`,
        );
      }
      return record as Record<string, unknown>;
    });
  }
  if (typeof selected === 'object') {
    return [selected as Record<string, unknown>];
  }
  throw new Error('HTTP source recordsPath must resolve to an object or array');
}

