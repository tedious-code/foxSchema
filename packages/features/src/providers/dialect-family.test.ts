/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `dialectFamily` replaced the same `d === 'mysql' || d === 'mariadb' ||
 * d === 'tidb'` chains written out at ~30 call sites, which is how Format came
 * to miss four dialects. Pin every dialect's answer so a new one is a
 * deliberate decision here rather than a silent `default` somewhere else.
 */
import { describe, expect, it } from 'vitest';
import { DIALECTS, dialectFamily } from '@foxschema/sql';
import { accessFamily } from '../modules/access/intent.js';

const EXPECTED: Record<string, string> = {
  postgres: 'postgres',
  cockroachdb: 'postgres',
  yugabytedb: 'postgres',
  redshift: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  tidb: 'mysql',
  sqlserver: 'sqlserver',
  azuresql: 'sqlserver',
  db2: 'db2',
  oracle: 'oracle',
  sqlite: 'sqlite',
  duckdb: 'duckdb',
  clickhouse: 'clickhouse',
  redis: 'redis',
  mongodb: 'mongodb',
};

describe('dialectFamily', () => {
  it('answers for every dialect', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...DIALECTS].sort());
    for (const d of DIALECTS) expect(dialectFamily(d), d).toBe(EXPECTED[d]);
  });

  it('is case-insensitive and passes unknown names through', () => {
    expect(dialectFamily('AzureSQL')).toBe('sqlserver');
    expect(dialectFamily('nosuch')).toBe('nosuch');
    expect(dialectFamily('constructor')).toBe('constructor');
    expect(dialectFamily('')).toBe('');
  });

  it('leaves accessFamily as it was: MariaDB keeps its own access model', () => {
    expect(accessFamily('mariadb')).toBe('mariadb');
    expect(accessFamily('tidb')).toBe('mysql');
    expect(accessFamily('redshift')).toBe('postgres');
    expect(accessFamily('azuresql')).toBe('sqlserver');
  });
});
