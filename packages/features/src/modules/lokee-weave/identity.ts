/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lokee Weave — stable database identity.
 *
 * History belongs to a *database*, not to a saved connection. Two saved
 * connections pointing at the same database must grow one history, and rotating
 * a password must not orphan it — so credentials are excluded from the
 * fingerprint by construction: this function has no parameter to pass them in.
 */

export interface DatabaseIdentityInput {
  dialect: string;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  schema?: string | null;
  /**
   * Escape hatch for when host/port is not a stable way to name the server — a
   * server GUID, a SQLite file's resolved path. It replaces *only* host and
   * port; database and schema still apply on top of it. Letting it replace the
   * whole tuple would give every database on one instance a single shared
   * history, silently merging staging into production.
   */
  instanceFingerprint?: string | null;
}

/** Empty and whitespace-only both mean "not supplied". */
function part(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * The text that gets hashed. Exposed separately so a mismatch is debuggable:
 * comparing two fingerprints tells you nothing, comparing two of these tells
 * you which component moved.
 *
 * Components are JSON-encoded rather than joined by a separator character. A
 * host or database name can legally contain whatever separator you might pick,
 * and `host="a b"` must not be able to spell the same text as `host="a"` plus
 * `database="b"`.
 */
export function databaseIdentityText(input: DatabaseIdentityInput): string {
  const fingerprint = part(input.instanceFingerprint);
  // A fingerprint replaces how the *server* is named, and nothing more.
  const server = fingerprint
    ? { kind: 'fingerprint', fingerprint }
    : { kind: 'tuple', host: part(input.host), port: input.port ?? null };
  return JSON.stringify([server, part(input.dialect), part(input.database), part(input.schema)]);
}

/**
 * Stable id for a database. Same database → same id, across saved connections,
 * password changes, and restarts.
 *
 * Host is *not* normalised beyond case: `localhost` and `127.0.0.1` produce
 * different ids even when they name the same server. Resolving that needs a
 * round trip to the database, so it is left to `instanceFingerprint`.
 */
export function databaseIdentity(
  input: DatabaseIdentityInput,
  digest: (text: string) => string
): string {
  return digest(databaseIdentityText(input));
}
