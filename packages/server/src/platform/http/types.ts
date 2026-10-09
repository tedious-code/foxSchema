/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The routing shapes, and the fields the auth guard puts on a request.
 *
 * Handlers take Fastify's own `FastifyRequest` and `FastifyReply`. There used
 * to be a request/response interface of our own here, with an adapter object
 * translating Fastify to it — scaffolding from removing Express, which let ~80
 * handlers keep their Express-shaped signatures instead of being rewritten in
 * the same change. With Express gone it only cost: it re-implemented a subset
 * of Fastify under different names, and anything it did not expose had to be
 * punched through it — which is how streamed responses came to drop every
 * header, security headers included.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppRole, Permission } from '@foxschema/shared';

/**
 * Fastify's request, told how loosely these handlers read the inputs.
 *
 * Fastify types `params`, `query` and `body` as `unknown` until a route
 * declares a schema for them. These handlers validate by hand and narrow at
 * the use site, which is what this instantiation says — it is Fastify's own
 * generic, not a type of ours standing in front of it.
 */
export type AppRequest = FastifyRequest<{
  Params: Record<string, string | undefined>;
  Querystring: Record<string, unknown>;
  Body: unknown;
}>;

export type NextFunction = (error?: unknown) => void;

/** A guard: answers the request itself, or calls `next()` to continue. */
export type Middleware = (
  req: AppRequest,
  res: FastifyReply,
  next: NextFunction
) => void | Promise<void>;

export type RouteHandler = (req: AppRequest, res: FastifyReply) => void | Promise<void>;

/**
 * A request the auth guard has run on.
 *
 * The fields are optional because an unauthenticated caller reaches the public
 * routes with none of them set; the RBAC guard is what turns a missing `userId`
 * into a 401. The name is the signal — it says a handler expects to be mounted
 * behind `authGuard`. Declared here rather than beside the guard so the
 * platform-level guards can read these fields without importing from a feature.
 */
export interface AuthedRequest extends AppRequest {
  userId?: string;
  appRole?: AppRole;
  permissions?: Set<Permission>;
  /** The owner of a personal install, in by launch link before creating an account. */
  launchSession?: boolean;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
