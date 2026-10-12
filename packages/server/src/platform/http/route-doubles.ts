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

/** What a fake reply recorded. `body` is `any`: tests read fields off whatever the route sent. */
interface SentReply {
  status?: number;
  body?: any;
  /**
   * Headers by lower-cased name. The last value set wins, except set-cookie,
   * which collects every cookie the way Fastify does.
   */
  headers: Record<string, string | string[]>;
}

/** A reply that records the status, body and headers a handler sends. */
export function fakeReply(): { reply: FastifyReply; sent: SentReply } {
  const sent: SentReply = { headers: {} };
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
    header(name: string, value: string | string[]) {
      const key = name.toLowerCase();
      const prev = sent.headers[key];
      sent.headers[key] = key === 'set-cookie' && prev !== undefined ? [prev, value].flat() : value;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}
