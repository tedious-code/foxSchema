/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/routes/pipes.ts).
 */
import { z } from 'zod';
import { PIPE_FAMILIES, TRIGGER_KINDS } from '@foxschema/workflow-engine';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from '../zod-provider.js';
import type { AppContext } from '../context.js';

const metadataSchema = z.object({
  type: z.string(),
  name: z.string(),
  category: z.string(),
  version: z.string(),
  role: z.enum(['source', 'transform', 'sink']),
  inputs: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['records', 'json', 'binary']),
    }),
  ),
  outputs: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['records', 'json', 'binary']),
    }),
  ),
  configSchema: z.record(z.string(), z.unknown()),
  simple: z.boolean().optional(),
  // The response schema is also a filter: a field missing here is silently
  // dropped from every reply. `palette`, `family`, `tags` and `sideEffects`
  // were, so the designer's advanced-pipes toggle and family grouping never
  // saw a value.
  sideEffects: z.boolean().optional(),
  palette: z.enum(['primary', 'advanced']).optional(),
  family: z.enum(PIPE_FAMILIES).optional(),
  tags: z.array(z.string()).optional(),
  triggerKind: z.enum([...TRIGGER_KINDS, '*']).optional(),
  provider: z
    .object({
      namespace: z.string(),
      origin: z.enum(['builtin', 'plugin']),
      package: z.string().optional(),
      packageVersion: z.string().optional(),
    })
    .optional(),
});

/**
 * Registry metadata for registry-driven designer palette / property panels.
 */
export function pipeRoutes(ctx: AppContext): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/pipes',
      {
        schema: {
          response: {
            200: z.object({ pipes: z.array(metadataSchema) }),
          },
        },
      },
      async () => ({ pipes: ctx.registry.listMetadata() }),
    );

  };
  return plugin;
}

