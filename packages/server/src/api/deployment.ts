/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which deployment shape this process is running as.
 *
 * The answer decides more than which auth guard is installed: a handful of
 * routes are only safe when the caller is the person sitting at the machine
 * (probing an arbitrary metadata-DB URL, installing a driver, self-updating).
 * Those checks used to be described in comments while the code did nothing, so
 * the predicate lives here where a route can actually call it.
 *
 * Read per call rather than captured at import: tests flip the variable, and a
 * module-load snapshot silently ignores them.
 */

/**
 * A personal install (desktop app, `fox open`) rather than a shared server.
 * `LOCAL_SINGLE_USER=false` declares a shared server.
 *
 * This no longer decides whether anyone signs in: every install does. It
 * decides only which machine-level actions a signed-in user may take.
 */
export function isLocalSingleUser(): boolean {
  return process.env.LOCAL_SINGLE_USER !== 'false';
}
