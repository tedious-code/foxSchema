/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deterministic serialisation. Key order must not decide identity.
 *
 * Two consumers depend on this and must not drift apart: result-grid cell
 * comparison (Postgres `jsonb` reorders keys on storage while `json` preserves
 * insertion order, so the same logical value arrives ordered differently from
 * two servers) and Lokee Weave hashing, where a reordered object would mint a
 * spurious schema version.
 */

/** JSON with object keys sorted, recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
