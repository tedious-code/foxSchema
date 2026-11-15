/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/storage/src/database-path.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Filename of the engine's database at the repo root. */
export const DEFAULT_DATABASE_FILENAME = 'workflow-engine.sqlite';

/** `name` of the workspace-root manifest, used to locate the repo root. */
const ROOT_PACKAGE_NAME = 'foxschema';

let cachedRoot: string | undefined;

/**
 * Resolve the metadata database location.
 *
 * Every engine process has to agree on one file. A bare relative filename is
 * resolved by `node:sqlite` against `process.cwd()` — and npm workspace scripts
 * leave cwd in `apps/web` or `packages/server`. Anchoring the default to the
 * repo root makes the location independent of where you stand.
 *
 * `FOXFLOW_DB_PATH` still wins, so deployments can put the file anywhere.
 */
export function resolveDatabasePath(explicit?: string): string {
  const chosen = explicit ?? process.env.FOXFLOW_DB_PATH;
  if (chosen === undefined || chosen === '') {
    return join(repoRoot(), DEFAULT_DATABASE_FILENAME);
  }
  // `:memory:` and `file:` URIs are SQLite's own forms, not filesystem paths.
  if (chosen === ':memory:' || chosen.startsWith('file:')) return chosen;
  // An explicit relative path is a deliberate choice; resolving it against cwd
  // is exactly what the caller asked for. Only the *default* is anchored.
  return isAbsolute(chosen) ? chosen : resolve(chosen);
}

/**
 * Walk up from this module to the workspace root. Throws rather than falling
 * back to cwd: a silent fallback would recreate the split-brain this function
 * exists to prevent, and an empty database is far harder to notice than a
 * startup error naming the escape hatch.
 */
function repoRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, 'package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from this module's own directory looking for the workspace manifest
    if (existsSync(manifest)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from this module's own directory looking for the workspace manifest
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === ROOT_PACKAGE_NAME
        ) {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        // An unreadable or malformed manifest is not the root marker; keep going.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Cannot locate the FoxSchema workspace root, so the default database path ' +
      'is undefined. Set FOXFLOW_DB_PATH to choose the file explicitly.',
  );
}
