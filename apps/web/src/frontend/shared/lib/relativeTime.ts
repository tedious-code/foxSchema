/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relative day labels for Runs / bookmarks / file imports.
 */

/** Calendar-day relative labels: "Today", "A day ago", "2 days ago", … */
export function formatRelativeDay(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const startOf = (n: number) => {
    const d = new Date(n);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOf(now) - startOf(ts)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'A day ago';
  return `${days} days ago`;
}

/** Parse API `createdAt` (ISO string or epoch ms/seconds) for relative day labels. */
export function importCreatedAtMs(createdAt: string | undefined): number {
  if (!createdAt) return 0;
  const n = Number(createdAt);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Files sidebar “When” cell — Today / A day ago / N days ago. */
export function formatFileImportWhen(createdAt: string | undefined, now = Date.now()): string {
  return formatRelativeDay(importCreatedAtMs(createdAt), now);
}
