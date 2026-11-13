/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/routes/credentials.ts).
 */
import { createCredentialSchema } from '@foxschema/workflow-engine';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '../zod-provider.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const metaSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Credential routes never return secret material — only metadata. Decryption
// happens exclusively inside the engine via revealSecret at run time.
export function credentialRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/credentials',
      { schema: { body: createCredentialSchema, response: { 201: metaSchema } } },
      async (req, reply) => {
        const meta = await ctx.credentials.create(req.body);
        return reply.code(201).send(meta);
      },
    );

    r.get(
      '/credentials',
      { schema: { response: { 200: z.array(metaSchema) } } },
      async () => ctx.credentials.list(),
    );

    r.delete(
      '/credentials/:id',
      { schema: { params: z.object({ id: z.string() }) } },
      async (req, reply) => {
        const removed = await ctx.credentials.remove(req.params.id);
        return reply.code(removed ? 204 : 404).send();
      },
    );
  };
}
