/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which statements open, end or abandon a transaction — the ones a batch run
 * as one transaction must not contain.
 */
import { describe, expect, it } from 'vitest';
import { isTransactionControl } from './sql-splitter.js';

describe('isTransactionControl', () => {
  it.each([
    'BEGIN',
    'begin;',
    'BEGIN TRANSACTION',
    'BEGIN WORK;',
    'BEGIN TRAN',
    'BEGIN TRANSACTION payroll',
    'BEGIN DISTRIBUTED TRANSACTION',
    'BEGIN IMMEDIATE',
    'BEGIN EXCLUSIVE TRANSACTION;',
    'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    'START TRANSACTION',
    'start transaction read only;',
    'COMMIT',
    'COMMIT WORK;',
    'END;',
    'ROLLBACK',
    'ROLLBACK TRANSACTION;',
    '-- leave it here\nCOMMIT;',
    '/* done */ ROLLBACK',
  ])('%j controls the transaction', (sql) => {
    expect(isTransactionControl(sql)).toBe(true);
  });

  it.each([
    // Stays inside the transaction.
    'ROLLBACK TO SAVEPOINT before_load',
    'ROLLBACK TO before_load',
    'ROLLBACK WORK TO SAVEPOINT s1',
    'SAVEPOINT before_load',
    'RELEASE SAVEPOINT before_load',
    // Procedural blocks, not transaction control.
    'BEGIN EXECUTE IMMEDIATE \'DROP TABLE t\'; END',
    'BEGIN\n  UPDATE t SET x = 1;\nEND;',
    'DECLARE n INTEGER; BEGIN NULL; END;',
    // Ordinary statements, including ones that only mention the words.
    "SELECT 'COMMIT' AS word",
    'INSERT INTO log (msg) VALUES (\'begin transaction\')',
    'START SLAVE',
    'UPDATE t SET ended = 1',
  ])('%j does not', (sql) => {
    expect(isTransactionControl(sql)).toBe(false);
  });
});
