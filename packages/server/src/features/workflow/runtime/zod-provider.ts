/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Zod validation and serialization for Fastify routes.
 *
 * Routes declare zod schemas under `schema:`. These two compilers and the type
 * provider were all the routes used from fastify-type-provider-zod, whose zod 4
 * releases also require @fastify/swagger as a peer.
 */
import type {
  FastifySchemaCompiler,
  FastifySerializerCompiler,
  FastifyTypeProvider,
} from 'fastify';
import type { z } from 'zod';

export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this['schema'] extends z.ZodType ? z.output<this['schema']> : unknown;
  serializer: this['schema'] extends z.ZodType ? z.input<this['schema']> : unknown;
}

function isZodSchema(schema: unknown): schema is z.ZodType {
  return typeof (schema as { safeParse?: unknown } | undefined)?.safeParse === 'function';
}

/** Parse the request part; the parsed value (defaults applied) replaces it. */
export const validatorCompiler: FastifySchemaCompiler<z.ZodType> =
  ({ schema }) =>
  (data) => {
    if (!isZodSchema(schema)) return { value: data };
    const parsed = schema.safeParse(data);
    if (parsed.success) return { value: parsed.data };
    return { error: parsed.error };
  };

/** Serialize through the response schema, so undeclared fields never leave. */
export const serializerCompiler: FastifySerializerCompiler<z.ZodType> =
  ({ schema }) =>
  (data) =>
    JSON.stringify(isZodSchema(schema) ? schema.parse(data) : data);
