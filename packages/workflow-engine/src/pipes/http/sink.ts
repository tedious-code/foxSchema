/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/http/src/sink.ts).
 */
import { z } from 'zod';
import { coerceHttpRequest, httpRequestSchema } from '../../common/index.js';
import type { PipeContext, RecordBatch, SinkPipe } from '../../registry/index.js';
import {
  definePipeMetadata,
  mapRecordsConcurrently,
  type PipeMetadata,
} from '../../sdk/index.js';
import { requestCredentialId, revealPipeSecret } from '../pipe-context.js';
import { executeHttpRequest, describeHttpFailure } from './request.js';

const configSchema = z
  .object({
    /**
     * The outbound request. Its `body` may reference `{{record.<field>}}`,
     * which resolves per record. Coerced first so the designer's flat shape
     * and the nested `request` form both parse.
     */
    request: z.preprocess(
      (input) => coerceHttpRequest(input),
      httpRequestSchema,
    ),
    /**
     * `record` sends one request per record (the common case for creating
     * resources); `batch` sends one request whose `{{records}}` is the whole
     * array (for bulk endpoints).
     */
    mode: z.enum(['record', 'batch']).default('record'),
    /** In-flight requests when mode is `record`. */
    concurrency: z.number().int().min(1).max(16).default(1),
    /** Fail the run, or drop the record and continue, on a non-2xx. */
    onError: z.enum(['fail', 'skip']).default('fail'),
  });

/**
 * Write records out over HTTP — the counterpart to `source.api.http`.
 *
 * Sinks are how a pipeline produces effects, and until now the only one was
 * Postgres; this covers "POST each record to an API" (create a CMS post, push
 * to a webhook, forward to another service).
 */
export class HttpSinkPipe implements SinkPipe {
  readonly type = 'sink.http';
  readonly role = 'sink';

  constructor(private readonly request?: typeof fetch) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'Send HTTP request',
      category: 'Output/API',
      family: 'http',
      tags: ['auth', 'api'],
      version: '0.1.0',
      role: 'sink',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema: {
        type: 'object',
        required: ['request'],
        properties: {
          request: {
            type: 'object',
            description:
              'Outbound request; body may use {{record.<field>}} per record',
          },
          mode: { type: 'string', enum: ['record', 'batch'], default: 'record' },
          concurrency: { type: 'integer', minimum: 1, maximum: 16, default: 1 },
          onError: { type: 'string', enum: ['fail', 'skip'], default: 'fail' },
        },
      },
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    configSchema.parse(config);
  }

  async write(batch: RecordBatch, context: PipeContext): Promise<void> {
    const config = configSchema.parse(context.pipe.config);
    // Revealed once per batch, not once per record — the secret is the same
    // for every request and each reveal is a store read plus a decrypt.
    const secret = await revealSecret(config, context);

    if (config.mode === 'batch') {
      // Nothing to send is not the same as sending nothing: an empty batch
      // must not POST an empty array to a bulk endpoint.
      if (batch.records.length === 0) return;
      await this.send(config, context, secret, { records: batch.records });
      return;
    }

    // `send` already applies `onError`, so anything that reaches the pool is
    // fatal: stop claiming records rather than firing requests at an endpoint
    // that just failed.
    await mapRecordsConcurrently(
      batch.records,
      config.concurrency,
      (record) =>
        this.send(config, context, secret, {
          record,
          // Flattened too, so `{{title}}` works as well as `{{record.title}}`.
          ...record,
        }),
    );
  }

  private async send(
    config: z.infer<typeof configSchema>,
    context: PipeContext,
    secret: Record<string, unknown> | undefined,
    scope: Record<string, unknown>,
  ): Promise<void> {
    const result = await executeHttpRequest({
      request: config.request,
      secret,
      credentialId: requestCredentialId(config.request.auth, context),
      credentials: context.credentials,
      variables: { ...context.variables, ...scope },
      trigger: {
        id: context.invocation?.triggerId,
        kind: context.invocation?.kind,
      },
      fetch: this.request,
      signal: context.signal,
    });

    if (!result.ok) {
      if (config.onError === 'skip') return;
      // `result.url` is the resolved address; `config.request.url` is still the
      // raw template. Reporting the template makes a failure read as if
      // interpolation broke — which sends you debugging the wrong thing.
      throw new Error(
        `HTTP sink ${config.request.method} ${result.url} ${describeHttpFailure(result)}`,
      );
    }
  }
}

async function revealSecret(
  config: z.infer<typeof configSchema>,
  context: PipeContext,
): Promise<Record<string, unknown> | undefined> {
  return revealPipeSecret(context, requestCredentialId(config.request.auth, context));
}
