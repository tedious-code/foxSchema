/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** The parts of a Compare side that say which database it is. */
export interface CompareSideConfig {
  dialect: string;
  schema: string;
  option: { host?: string; database?: string; connectionString?: string };
}

function isPicked(config: CompareSideConfig): boolean {
  return Boolean(
    (config.option.host ?? '').trim() ||
      (config.option.database ?? '').trim() ||
      (config.option.connectionString ?? '').trim()
  );
}

/**
 * Whether Original and Target name the same database and schema — comparing a
 * schema with itself finds nothing. Two sides nobody has picked yet are not
 * "the same database"; treating them as such put a "Same DB" warning in front
 * of every new user before they had done anything.
 */
export function pointsToSameDatabase(a: CompareSideConfig, b: CompareSideConfig): boolean {
  return (
    isPicked(a) &&
    isPicked(b) &&
    a.dialect === b.dialect &&
    (a.option.host ?? '') === (b.option.host ?? '') &&
    (a.option.database ?? '') === (b.option.database ?? '') &&
    a.schema.trim().toUpperCase() === b.schema.trim().toUpperCase()
  );
}
