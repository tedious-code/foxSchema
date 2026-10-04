/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Quoting and paths shared by the per-engine backup commands.
 *
 * A database name, a folder and a table name all reach a shell or a SQL string
 * here, and any of them can hold a space or a quote. Each gets quoted for where
 * it lands, so a copied command does what it says rather than splitting on a
 * space or ending a string early.
 */

/** One shell word: bare when it is plainly safe, single-quoted otherwise. */
export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A Windows path (`C:\…`, `\\server\…`) joins with backslashes; anything else with slashes. */
function usesBackslash(folder: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith('\\\\') || (folder.includes('\\') && !folder.includes('/'));
}

/** `folder` + `name`, with the folder's own separator and no doubled one. */
export function joinPath(folder: string, name: string): string {
  const trimmed = folder.trim();
  if (!trimmed) return name;
  const sep = usesBackslash(trimmed) ? '\\' : '/';
  return `${trimmed.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** `host`, `port` as given, or nothing for an engine that runs on a file. */
export function portOf(port: number | string | null | undefined): string {
  const p = String(port ?? '').trim();
  return /^\d+$/.test(p) ? p : '';
}
