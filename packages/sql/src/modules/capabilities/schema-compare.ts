/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whether two engines can be compared, without loading what compares them.
 *
 * The Compare button asks this on every first page. Answered through the full
 * capability table it loaded every engine's DDL, account and client code first
 * (about 25 kB gzip), all of it to read one flag. This asks the light key list
 * instead; the capability table uses it for its own schemaCompare column, so
 * the two answers are one answer.
 */
import { hasSqlDialect } from '../dialect/sql-dialect-keys.js';
import type { FeatureSupport } from './dialect-features.js';
import { fallbackReason, isKnownEngine, unknownEngineReason } from './feature-reasons.js';

/** Engines a connection can use that have no schema to compare, and why. */
const NO_SCHEMA: Record<string, string> = {
  redis: 'Redis has no schema to compare — keys are not tables.',
  mongodb: 'MongoDB has no schema to compare — collections are not tables.',
};

/** Exactly the engines with a SQL dialect can be compared. */
export function schemaCompareSupport(dialect: string): FeatureSupport {
  const key = (dialect || '').toLowerCase();
  if (!isKnownEngine(key)) return { supported: false, reason: unknownEngineReason(dialect, 'schemaCompare') };
  if (hasSqlDialect(key)) return { supported: true };
  return { supported: false, reason: NO_SCHEMA[key] ?? fallbackReason(key, 'schemaCompare') };
}

/**
 * Why this pair of engines cannot be compared, or null when they can.
 *
 * Comparing takes two connections and either side disqualifies it, so the
 * button and the store were asking the same two-part question in two copies
 * that had already drifted by one guard clause. One answer cannot disagree
 * with itself.
 */
export function schemaCompareBlocker(source: string, target: string): string | null {
  for (const [side, dialect] of [
    ['Source', source],
    ['Target', target],
  ] as const) {
    const answer = schemaCompareSupport(dialect);
    if (!answer.supported) return `${side}: ${answer.reason}`;
  }
  return null;
}
