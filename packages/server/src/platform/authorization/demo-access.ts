/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * What a demo account may call.
 *
 * A published demo has one account whose login anyone can read, so its
 * permissions are not the whole story: a write any permission allowed would be
 * a write every visitor shares. So a demo account may read whatever its role
 * allows, and may write only through the routes below. Each of them reads,
 * whatever its verb: a SELECT goes over POST because it carries a body, not
 * because it changes anything.
 *
 * This is an allow-list on purpose. A route added later is closed to the demo
 * until someone decides it reads, rather than open until someone notices it
 * writes. `demo-access.test.ts` checks every entry against the real route
 * table, so a renamed route fails the build instead of quietly closing.
 */
import { isDemoRole } from '@foxschema/shared';

export interface DemoRoute {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The route as registered, with `:params`. */
  path: string;
  /** Why it only reads, for whoever reviews the list next. */
  why: string;
}

export const DEMO_ALLOWED_WRITES: readonly DemoRoute[] = [
  {
    method: 'POST',
    path: '/api/sql/execute',
    why: 'Runs SQL, and the demo role has no editor.dml, editor.ddl or editor.grant: only reads pass the gate.',
  },
  { method: 'POST', path: '/api/sql/code-cell/transpile', why: 'Compiles a TypeScript cell for the browser; never runs it.' },
  { method: 'POST', path: '/api/schema/list', why: 'Lists schemas.' },
  { method: 'POST', path: '/api/schema/load', why: 'Reads a schema.' },
  { method: 'POST', path: '/api/schema/table-insight', why: 'Reads catalog statistics for one table.' },
  { method: 'POST', path: '/api/schema/db-access', why: 'Reads database users and grants.' },
  { method: 'POST', path: '/api/compare', why: 'Compares two schemas; deploying the result is schema.migrate.' },
  {
    method: 'PUT',
    path: '/api/user/preferences',
    why: 'Theme and onboarding state. Shared by every visitor, and harmless to share.',
  },
];

/** The answer a demo account gets for anything else. */
export const DEMO_READ_ONLY = 'This is a read-only demo: browsing, comparing and running queries work; saving and changing do not.';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether `role` may call `method path`. Only a demo account is limited;
 * everyone else answers to their permissions alone.
 */
export function demoMayCall(role: unknown, method: string, path: string): boolean {
  if (!isDemoRole(role)) return true;
  const verb = method.toUpperCase();
  if (READS.has(verb)) return true;
  return DEMO_ALLOWED_WRITES.some((r) => r.method === verb && r.path === path);
}
