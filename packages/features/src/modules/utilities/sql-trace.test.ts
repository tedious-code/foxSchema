/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { redactSqlText } from './sql-trace';

describe('redactSqlText', () => {
  it.each([
    ["ALTER USER app IDENTIFIED BY \"S3cret!\"", 'ALTER USER app IDENTIFIED BY \'***\''],
    ['CREATE USER app IDENTIFIED BY hunter2', "CREATE USER app IDENTIFIED BY '***'"],
    ["CREATE USER 'a'@'%' IDENTIFIED WITH caching_sha2_password BY 'p@ss'", "CREATE USER 'a'@'%' IDENTIFIED WITH caching_sha2_password BY '***'"],
    ["CREATE ROLE r LOGIN PASSWORD 'it''s secret'", "CREATE ROLE r LOGIN PASSWORD '***'"],
    ["ALTER LOGIN app WITH PASSWORD = 'N3w!'", "ALTER LOGIN app WITH PASSWORD = '***'"],
    ["CREATE SECRET s (TYPE S3, KEY_ID 'AKIA1', SECRET 'abc')", "CREATE SECRET s (TYPE S3, KEY_ID '***', SECRET '***')"],
    ["SELECT * FROM dblink('host=db user=u password=pw1;', 'q')", "SELECT * FROM dblink('host=db user=u password=***;', 'q')"],
    ["COPY t FROM 's3://key:secret@bucket/x'", "COPY t FROM 's3://key:***@bucket/x'"],
    ['AUTH default s3cr3t', 'AUTH ***'],
  ])('%s', (input, expected) => {
    expect(redactSqlText(input)).toBe(expected);
  });

  it('leaves ordinary SQL alone', () => {
    const sql = "SELECT id, name FROM users WHERE email = 'a@x' AND status = 'paid'";
    expect(redactSqlText(sql)).toBe(sql);
  });

  it('never returns the secret, wherever it sits', () => {
    for (const sql of [
      "alter user x identified by 'topsecret'",
      "CREATE USER u WITH PASSWORD 'topsecret' VALID UNTIL 'infinity'",
      'mysql://root:topsecret@db:3306/app',
    ]) {
      expect(redactSqlText(sql), sql).not.toContain('topsecret');
    }
  });
});
