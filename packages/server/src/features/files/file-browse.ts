/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Directory listing for the SQLite / DuckDB file picker.
 *
 * The browser cannot hand the server a real path — an OS file dialog gives a
 * `File` with a name and no location — so a database file that lives on the
 * machine running Fox Schema can only be picked by listing that machine.
 *
 * What this deliberately is *not*: a file manager. It returns names, sizes and
 * mtimes, never contents, and the only files it names are ones a database
 * driver could open. A signed-in user could already reach any of these by
 * typing the path into the connection form; this makes that discoverable
 * without widening what they can actually do with it.
 */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

/** Extensions a SQLite or DuckDB connection could actually open. */
export const DATABASE_FILE_EXTENSIONS = [
  '.db',
  '.db3',
  '.sqlite',
  '.sqlite3',
  '.duckdb',
  '.ddb',
] as const;

export interface FileBrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  /** Files only. */
  size?: number;
  modifiedAt?: string;
}

export interface FileBrowseResult {
  /** The directory that was listed, absolute and normalized. */
  path: string;
  /** Parent directory, or null at the filesystem root. */
  parent: string | null;
  /** Where "Home" jumps to, so the client does not have to guess. */
  home: string;
  entries: FileBrowseEntry[];
  /** True when the listing was cut at the cap — the client says so. */
  truncated: boolean;
}

/** Directories with thousands of entries are a UI hazard, not a feature. */
const MAX_ENTRIES = 500;

export function isDatabaseFile(name: string): boolean {
  const lower = name.toLowerCase();
  return DATABASE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Resolve the requested directory.
 *
 * A relative or empty path resolves against the home directory rather than the
 * server process's cwd: cwd is wherever the service happened to be started
 * from, which is not a place the user has any model of.
 */
export function resolveBrowsePath(raw: string | undefined, home = homedir()): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return home;
  // A NUL byte truncates the path inside libc — reject rather than normalize,
  // because "/safe\0/../../etc" is two different paths depending on who reads it.
  if (trimmed.includes('\0')) return home;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(home, trimmed);
}

/** Parent of `dir`, or null once dirname stops moving (the root). */
export function parentOf(dir: string): string | null {
  const parent = dirname(dir);
  return parent === dir ? null : parent;
}

/**
 * List one directory: sub-directories, then database files.
 *
 * Hidden entries are skipped — a `.git` or `.cache` full of nothing openable is
 * noise — but a user who types a dotted path can still browse into it, because
 * the filter applies to what is listed, not to where you may go.
 */
export async function browseDirectory(rawPath?: string): Promise<FileBrowseResult> {
  const home = homedir();
  const path = resolveBrowsePath(rawPath, home);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the user-supplied path IS the feature; it is resolved above, rejected if it carries a NUL, and only ever stat'd or listed, never read or written
  const info = await stat(path);
  if (!info.isDirectory()) {
    // Being handed a file is normal: the picker reopens on the last used path,
    // which is a file. List where it lives.
    return browseDirectory(dirname(path));
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same path, already resolved and validated; listing names is the whole operation
  const dirents = await readdir(path, { withFileTypes: true });
  const dirs: FileBrowseEntry[] = [];
  const files: FileBrowseEntry[] = [];

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    const full = path.endsWith(sep) ? `${path}${dirent.name}` : `${path}${sep}${dirent.name}`;
    if (dirent.isDirectory()) {
      dirs.push({ name: dirent.name, path: full, kind: 'dir' });
      continue;
    }
    // A symlink to a database file is still a database file; a symlink to a
    // directory is followed on click, by the same stat as any other path.
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
    if (!isDatabaseFile(dirent.name)) continue;
    let size: number | undefined;
    let modifiedAt: string | undefined;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- `full` is a child of the directory just listed, not caller input
      const fileInfo = await stat(full);
      if (fileInfo.isDirectory()) continue;
      size = fileInfo.size;
      modifiedAt = fileInfo.mtime.toISOString();
    } catch {
      // A dangling symlink or a file removed mid-listing: still worth naming,
      // just without its details.
    }
    files.push({ name: dirent.name, path: full, kind: 'file', size, modifiedAt });
  }

  const byName = (a: FileBrowseEntry, b: FileBrowseEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  dirs.sort(byName);
  files.sort(byName);

  const all = [...dirs, ...files];
  return {
    path,
    parent: parentOf(path),
    home,
    entries: all.slice(0, MAX_ENTRIES),
    truncated: all.length > MAX_ENTRIES,
  };
}

/** Human-readable reason a directory could not be listed. */
export function browseErrorMessage(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return `No such directory: ${path}`;
  if (code === 'EACCES' || code === 'EPERM') return `Permission denied: ${path}`;
  if (code === 'ENOTDIR') return `Not a directory: ${basename(path)}`;
  return error instanceof Error ? error.message : 'Failed to list directory';
}
