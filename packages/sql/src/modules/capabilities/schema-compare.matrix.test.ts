/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The light Compare check and the full capability table, on every engine.
 *
 * The Compare button asks `schemaCompareSupport` so the first page does not
 * load every engine's code; the capability table answers the same question
 * for every other screen. They are meant to be one answer. This proves it for
 * every engine a connection can use, for spellings a saved connection might
 * carry, and for names that are not engines at all — reason text included,
 * since that is what a reader sees.
 */
import { describe, expect, it } from 'vitest';
import { PROVIDER_SETTINGS } from '../../providers/provider-settings.js';
import { dialectFeatures } from './dialect-features.js';
import { schemaCompareBlocker, schemaCompareSupport } from './schema-compare.js';

/** Every engine, and whether it can be compared. */
const EXPECTED: Record<string, boolean> = {
  postgres: true,
  yugabytedb: true,
  cockroachdb: true,
  redshift: true,
  mysql: true,
  mariadb: true,
  tidb: true,
  sqlserver: true,
  azuresql: true,
  oracle: true,
  db2: true,
  clickhouse: true,
  sqlite: true,
  duckdb: true,
  // Keys and collections are not tables.
  redis: false,
  mongodb: false,
};

const SPELLINGS = (d: string) => [d, d.toUpperCase(), d[0]!.toUpperCase() + d.slice(1)];
const NOT_ENGINES = ['', 'notadb', 'postgresql', 'mssql', 'sqlite3', 'cassandra', ' postgres', 'constructor', '__proto__'];

describe('schemaCompareSupport agrees with dialectFeatures, every engine', () => {
  it('names every engine a connection can use', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(PROVIDER_SETTINGS).sort());
  });

  for (const [dialect, comparable] of Object.entries(EXPECTED)) {
    for (const spelling of SPELLINGS(dialect)) {
      it(`${spelling}: ${comparable ? 'can' : 'cannot'} be compared, in both answers`, () => {
        const light = schemaCompareSupport(spelling);
        expect(light).toEqual(dialectFeatures(spelling).schemaCompare);
        expect(light.supported).toBe(comparable);
        if (!comparable) expect(light.reason).toMatch(/no schema to compare/);
      });
    }
  }

  for (const name of NOT_ENGINES) {
    it(`${JSON.stringify(name)} is not an engine, and both answers say so in the same words`, () => {
      const light = schemaCompareSupport(name);
      expect(light).toEqual(dialectFeatures(name).schemaCompare);
      expect(light.supported).toBe(false);
      expect(light.reason?.length ?? 0).toBeGreaterThan(10);
    });
  }

  it('blocks a pair on whichever side cannot be compared, naming the side', () => {
    expect(schemaCompareBlocker('postgres', 'mysql')).toBeNull();
    expect(schemaCompareBlocker('redis', 'postgres')).toMatch(/^Source: Redis has no schema/);
    expect(schemaCompareBlocker('postgres', 'mongodb')).toMatch(/^Target: MongoDB has no schema/);
    expect(schemaCompareBlocker('notadb', 'postgres')).toMatch(/^Source: /);
  });
});
