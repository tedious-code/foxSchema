/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test doubles for calling one route handler without a server: the handler
 * pulled out of a router, and a reply that records what it sent. Route unit
 * tests use these; `api/http-contract.test.ts` drives a real listener instead.
 *
 * No test framework imported here, so runtime code could not depend on one by
 * importing this by mistake.
 */
import type { FastifyReply } from 'fastify';
import type { Router } from './router';
import type { HttpMethod, RouteHandler } from './types';

/** The handler `router` declares for `method` and `path` (as declared, relative to the router). */
export function routeHandler(router: Router, method: HttpMethod, path: string): RouteHandler {
  const route = router.flatten().find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`${method} ${path} is not registered`);
  return route.handler;
}

/** A reply that records the status and body a handler sends. */
export function fakeReply(): {
  reply: FastifyReply;
  /** `any`: tests read fields off whatever the route sent. */
  sent: { status?: number; body?: any };
} {
  const sent: { status?: number; body?: any } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    code(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
    header() {
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}
