/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { assertSafeSqliteSql } from './sqlite-sql-guard.js';

describe('assertSafeSqliteSql', () => {
  it('allows normal DDL, DML, CTEs, and metadata PRAGMAs', () => {
    const allowed = [
      'SELECT 1',
      'SELECT * FROM users WHERE note = \'ATTACH DATABASE "/data/foxschema.db" AS m\'',
      'SELECT attach, detach FROM email_attachments',
      'CREATE TABLE attachments (id INTEGER PRIMARY KEY, attach TEXT)',
      'INSERT INTO logs VALUES (\'VACUUM INTO /tmp/x\', \'load_extension("x")\')',
      'PRAGMA database_list',
      'PRAGMA table_info("users")',
      'PRAGMA foreign_keys = ON',
      'VACUUM',
      'VACUUM main',
      'WITH c AS (SELECT 1 AS n) SELECT * FROM c',
    ];
    for (const sql of allowed) {
      expect(() => assertSafeSqliteSql(sql), sql).not.toThrow();
    }
  });

  it('rejects ATTACH and DETACH including comment, whitespace, EXPLAIN, and multi-statement forms', () => {
    const blocked = [
      "ATTACH DATABASE '/data/foxschema.db' AS meta",
      "attach '/data/foxschema.db' as m",
      "/* hide */ ATTACH /* x */ DATABASE '/data/foxschema.db' AS m",
      "-- leading comment\nATTACH DATABASE '/data/foxschema.db' AS m",
      "EXPLAIN ATTACH DATABASE '/data/foxschema.db' AS m",
      "EXPLAIN QUERY PLAN ATTACH '/data/foxschema.db' AS m",
      'DETACH DATABASE meta',
      'DETACH meta',
      "SELECT 1; ATTACH DATABASE '/data/foxschema.db' AS m",
    ];
    for (const sql of blocked) {
      expect(() => assertSafeSqliteSql(sql), sql).toThrow(/ATTACH and DETACH/i);
    }
  });

  it('rejects VACUUM INTO file writes', () => {
    const blocked = [
      "VACUUM INTO '/tmp/dump.sqlite'",
      "VACUUM main INTO '/tmp/dump.sqlite'",
      "/* c */ vacuum /* c */ into '/tmp/dump.sqlite'",
      "EXPLAIN VACUUM INTO '/tmp/dump.sqlite'",
    ];
    for (const sql of blocked) {
      expect(() => assertSafeSqliteSql(sql), sql).toThrow(/VACUUM INTO/i);
    }
  });

  it('rejects load_extension() calls in bare or quoted identifier forms', () => {
    const blocked = [
      "SELECT load_extension('/tmp/evil.so')",
      "SELECT LOAD_EXTENSION ('/tmp/evil.so')",
      'SELECT "load_extension"(\'/tmp/evil.so\')',
      "SELECT `load_extension`('/tmp/evil.so')",
      "SELECT [load_extension]('/tmp/evil.so')",
    ];
    for (const sql of blocked) {
      expect(() => assertSafeSqliteSql(sql), sql).toThrow(/load_extension/i);
    }
  });

  it('rejects dangerous schema-safety and directory PRAGMAs', () => {
    const blocked = [
      'PRAGMA writable_schema = ON',
      'PRAGMA main.writable_schema = 1',
      'PRAGMA "trusted_schema" = ON',
      "PRAGMA temp_store_directory = '/tmp'",
      "PRAGMA data_store_directory = '/data'",
    ];
    for (const sql of blocked) {
      expect(() => assertSafeSqliteSql(sql), sql).toThrow(/PRAGMA/i);
    }
  });
});
