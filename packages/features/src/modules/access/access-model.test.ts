/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * `hasAccessModel` replaced a hand-kept list of families that had to match the
 * capability table's keys. It decides whether generated GRANTs carry the
 * "these use PostgreSQL's syntax, check them" warning.
 */
import { describe, expect, it } from 'vitest';
import { hasAccessModel } from './intent.js';

describe('hasAccessModel', () => {
  it.each(['postgres', 'mysql', 'mariadb', 'sqlserver', 'db2', 'oracle', 'azuresql', 'tidb', 'cockroachdb', 'yugabytedb', 'redshift'])(
    '%s has its own privilege model',
    (d) => expect(hasAccessModel(d)).toBe(true)
  );

  it.each(['sqlite', 'duckdb', 'clickhouse', 'mongodb', 'redis', ''])('%s falls back', (d) =>
    expect(hasAccessModel(d)).toBe(false)
  );
});
