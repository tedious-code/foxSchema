/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { stripCreateViewHeader } from './view-definition.js';

const BODY = 'SELECT id, name FROM customers';

describe('stripCreateViewHeader', () => {
  it('strips the plain header SQLite stores in sqlite_master.sql', () => {
    expect(stripCreateViewHeader(`CREATE VIEW v_customers AS ${BODY};`)).toBe(BODY);
  });

  it('keeps a definition that is already just the query', () => {
    expect(stripCreateViewHeader(BODY)).toBe(BODY);
  });

  it.each([
    ['OR REPLACE', `CREATE OR REPLACE VIEW v AS ${BODY}`],
    ['TEMP', `CREATE TEMP VIEW v AS ${BODY}`],
    ['TEMPORARY', `CREATE TEMPORARY VIEW v AS ${BODY}`],
    ['IF NOT EXISTS', `CREATE VIEW IF NOT EXISTS v AS ${BODY}`],
    ['schema qualifier', `CREATE VIEW main.v AS ${BODY}`],
    ['column list', `CREATE VIEW v (id, name) AS ${BODY}`],
    ['lowercase', `create view v as ${BODY}`],
    ['extra whitespace', `CREATE   VIEW\n  v\n AS\n ${BODY}`],
  ])('strips a header with %s', (_label, sql) => {
    expect(stripCreateViewHeader(sql)).toBe(BODY);
  });

  it.each([
    ['double quotes', `CREATE VIEW "my view" AS ${BODY}`],
    ['brackets', `CREATE VIEW [my view] AS ${BODY}`],
    ['backticks', `CREATE VIEW \`my view\` AS ${BODY}`],
    ['quoted schema and name', `CREATE VIEW "main"."my view" AS ${BODY}`],
  ])('strips a header whose name uses %s', (_label, sql) => {
    expect(stripCreateViewHeader(sql)).toBe(BODY);
  });

  it('consumes comment lines written above the CREATE', () => {
    expect(stripCreateViewHeader(`-- one\n-- two\nCREATE VIEW v AS ${BODY}`)).toBe(BODY);
  });

  it('leaves an inner AS in the query alone', () => {
    const body = 'SELECT c.id AS customer_id FROM customers c';
    expect(stripCreateViewHeader(`CREATE VIEW v AS ${body}`)).toBe(body);
  });

  it('does not mistake a CREATE TABLE for a view header', () => {
    const sql = 'CREATE TABLE t (id INTEGER)';
    expect(stripCreateViewHeader(sql)).toBe(sql);
  });

  it('answers empty for a missing definition', () => {
    expect(stripCreateViewHeader(null)).toBe('');
    expect(stripCreateViewHeader(undefined)).toBe('');
    expect(stripCreateViewHeader('')).toBe('');
  });
});
