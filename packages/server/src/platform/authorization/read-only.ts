/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which requests an account without `app.write` may make: every GET, and the
 * writes whose route declares that it only reads (`reads` in router.ts, beside
 * the handler: a SELECT goes over POST because it carries a body, not because
 * it changes anything). Everything else refuses it before the handler runs.
 *
 * The Demo role is the role without `app.write`: a published demo's shared
 * login can browse, compare and query, and save nothing every visitor would
 * share. A new route is closed to such an account until it is declared to read,
 * rather than open until someone notices it writes; `api/demo-account.test.ts`
 * calls every guarded write as one and keeps the list of `reads` routes reviewed.
 */
import type { Permission } from '@foxschema/shared';

/** The answer a read-only account gets for anything it may not do. */
export const READ_ONLY_ACCOUNT =
  'This account is read-only: browsing, comparing and running queries work; saving and changing do not.';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether an account with `permissions` may call a `method` route that does (or does not) declare `reads`. */
export function requestAllowed(
  permissions: readonly Permission[] | ReadonlySet<Permission>,
  method: string,
  routeReads: boolean
): boolean {
  if (READS.has(method.toUpperCase()) || routeReads) return true;
  return 'has' in permissions ? permissions.has('app.write') : permissions.includes('app.write');
}
