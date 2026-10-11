/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import type { DbObjectType } from '@foxschema/db';

/**
 * Object types a Lokee capture reads.
 *
 * It lives here, next to the history feature that owns it. Nothing under
 * `features/` imports the composition root, so the list cannot live there.
 *
 * Two callers need the *same* list: the live capture (`live-capture.service.ts`), and the
 * force-migrate routes, which read a target's live schema to diff a stored
 * version against it. A second copy would be free to drift, and drift here is
 * silent — a shorter list makes force-migrate diff against a schema missing its
 * views and functions, and the generated plan would quietly drop them.
 *
 * Curated, not derived: this is 8 of `DbObjectType`'s 9 members, omitting
 * `ROLE`, which is an account rather than a schema object.
 */
export const LOKEE_FULL_SCOPE: DbObjectType[] = [
  'TABLE',
  'MQT',
  'VIEW',
  'FUNCTION',
  'PROCEDURE',
  'TRIGGER',
  'SEQUENCE',
  'TYPE',
];
