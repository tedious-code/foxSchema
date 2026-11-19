/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Filesystem guard for embedded user database connections (SQLite / DuckDB).
 *
 * Prevents users and workflows from opening FoxSchema's own metadata store
 * (`foxschema.db`), the workflow engine store (`workflow-engine.sqlite`), or
 * local key material (`.app_encryption_key`) — directly, via `file:` URIs,
 * via WAL/SHM/journal companion paths, via symlinks, or via hard links.
 */
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const PROTECTED_INTERNAL_BASENAMES = new Set([
  'foxschema.db',
  'workflow-engine.sqlite',
  '.app_encryption_key',
]);

function stripSqliteCompanionSuffix(filePath: string): string {
  return filePath.replace(/(?:-wal|-shm|-journal)$/i, '');
}

/**
 * Resolve symlinks for `targetPath` when it exists, or for its nearest existing
 * ancestor when the file itself does not exist yet (e.g. a new DuckDB file or a
 * not-yet-created `-wal` companion).
 */
function resolveRealPathOrAncestor(targetPath: string): string {
  const abs = resolve(targetPath);
  const trailing: string[] = [];
  let cursor = abs;
  while (true) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicalizing candidate or configured DB path to defeat symlink aliases
      const real = realpathSync(cursor);
      return trailing.length > 0 ? join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      trailing.push(basename(cursor));
      cursor = parent;
    }
  }
}

function statDeviceInode(filePath: string): { dev: number; ino: number } | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- comparing (dev, ino) to detect hard links to internal FoxSchema databases
    const st = statSync(filePath);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function isInMemoryTarget(trimmed: string): boolean {
  const lower = trimmed.toLowerCase();
  return (
    lower === ':memory:' ||
    lower === 'file::memory:' ||
    lower.startsWith('file::memory:?') ||
    lower.startsWith('file::memory:#')
  );
}

function normalizeEmbeddedFileTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || isInMemoryTarget(trimmed)) {
    return null;
  }
  if (trimmed.includes('\0')) {
    return trimmed;
  }
  if (/^file:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return resolve(decodeURIComponent(parsed.pathname));
    } catch {
      const stripped = trimmed.slice(5).split(/[?#]/)[0] ?? '';
      let decoded = stripped;
      try {
        decoded = decodeURIComponent(stripped);
      } catch {
        // Keep raw if percent-encoding is malformed.
      }
      return resolve(decoded);
    }
  }
  return resolve(trimmed);
}

function collectBlockedTargets(extraBlockedPaths: readonly (string | undefined)[] = []): string[] {
  const rawTargets: (string | undefined)[] = [
    process.env.APP_DB_PATH,
    process.env.FOXFLOW_DB_PATH,
    ...extraBlockedPaths,
  ];
  const expanded: string[] = [];
  for (const raw of rawTargets) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === ':memory:') continue;
    const normalized = resolve(stripSqliteCompanionSuffix(trimmed));
    expanded.push(normalized);
    // Protect the local encryption key stored alongside the metadata DB.
    expanded.push(join(dirname(normalized), '.app_encryption_key'));
  }
  return [...new Set(expanded)];
}

/**
 * Returns `true` if `rawTarget` points to FoxSchema's internal metadata DB,
 * workflow engine DB, or local encryption key file — including via `file:` URI,
 * SQLite WAL/SHM/journal companion path, symlink, or hard link.
 */
export function isProtectedEmbeddedDatabasePath(
  rawTarget: string,
  extraBlockedPaths: readonly (string | undefined)[] = [],
): boolean {
  if (rawTarget.includes('\0')) return true;
  const candidateExact = normalizeEmbeddedFileTarget(rawTarget);
  if (!candidateExact) return false;

  const candidateBase = resolve(stripSqliteCompanionSuffix(candidateExact));
  const candidateRealExact = resolveRealPathOrAncestor(candidateExact);
  const candidateRealBase = resolve(stripSqliteCompanionSuffix(candidateRealExact));

  for (const p of [candidateExact, candidateBase, candidateRealExact, candidateRealBase]) {
    if (PROTECTED_INTERNAL_BASENAMES.has(basename(p).toLowerCase())) {
      return true;
    }
  }

  const blockedPaths = collectBlockedTargets(extraBlockedPaths);
  const candidateCanonicalSet = new Set([
    candidateExact,
    candidateBase,
    candidateRealExact,
    candidateRealBase,
  ]);
  const candidateInodes = [candidateExact, candidateBase]
    .map((p) => statDeviceInode(p))
    .filter((id): id is { dev: number; ino: number } => id !== null);

  for (const blocked of blockedPaths) {
    const blockedReal = resolveRealPathOrAncestor(blocked);
    if (candidateCanonicalSet.has(blocked) || candidateCanonicalSet.has(blockedReal)) {
      return true;
    }
    if (candidateInodes.length > 0) {
      const blockedInode = statDeviceInode(blocked);
      if (
        blockedInode &&
        candidateInodes.some((c) => c.dev === blockedInode.dev && c.ino === blockedInode.ino)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Throws an Error if `rawTarget` resolves to a protected FoxSchema internal
 * database or encryption key file.
 */
export function assertSafeEmbeddedDatabasePath(
  rawTarget: string,
  extraBlockedPaths: readonly (string | undefined)[] = [],
): void {
  if (isProtectedEmbeddedDatabasePath(rawTarget, extraBlockedPaths)) {
    throw new Error('Cannot open Fox Schema internal metadata database as a user connection.');
  }
}
