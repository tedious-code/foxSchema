/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { DIALECTS, dialectHasTransactions } from '@foxschema/sql';
import {
  dialectSupportsTransactionalDdlRollback,
  DDL_AUTOCOMMITS_TABLE,
  dialectSupportsTransactionalRollback,
} from './dialect-transaction-support.js';

describe('dialectSupportsTransactionalRollback', () => {
  it('is false for adapters whose rollback is a documented no-op', () => {
    expect(dialectSupportsTransactionalRollback('redis')).toBe(false);
    expect(dialectSupportsTransactionalRollback('Redis')).toBe(false);
    expect(dialectSupportsTransactionalRollback('mongodb')).toBe(false);
    expect(dialectSupportsTransactionalRollback('clickhouse')).toBe(false);
  });

  it('is true for dialects with real DML transactions (including MySQL/Oracle)', () => {
    // Data-migrate DML still rolls back on these — only DDL auto-commits.
    expect(dialectSupportsTransactionalRollback('mysql')).toBe(true);
    expect(dialectSupportsTransactionalRollback('oracle')).toBe(true);
    expect(dialectSupportsTransactionalRollback('postgres')).toBe(true);
    expect(dialectSupportsTransactionalRollback('sqlite')).toBe(true);
    expect(dialectSupportsTransactionalRollback('sqlserver')).toBe(true);
  });
});

  it('still rolls back DML on CockroachDB — only its DDL auto-commits', () => {
    // The DDL fix below must not leak into this answer. It did once: the edit
    // that added the CockroachDB case landed in *both* switches, because they
    // end in the same `default: return true`. Nothing caught it — the DDL
    // helper short-circuits on this one, so its own test still saw false.
    //
    // Getting this wrong tells a data-migrate user their INSERT/UPDATE/DELETE
    // rollback could not be confirmed when CockroachDB did in fact roll it
    // back, which is the mirror image of the bug the DDL change fixes.
    expect(dialectSupportsTransactionalRollback('cockroachdb')).toBe(true);
    expect(dialectSupportsTransactionalRollback('CockroachDB')).toBe(true);
  });

describe('dialectSupportsTransactionalDdlRollback', () => {
  it('is false when DDL auto-commits (MySQL family + Oracle)', () => {
    expect(dialectSupportsTransactionalDdlRollback('mysql')).toBe(false);
    expect(dialectSupportsTransactionalDdlRollback('MariaDB')).toBe(false);
    expect(dialectSupportsTransactionalDdlRollback('tidb')).toBe(false);
    expect(dialectSupportsTransactionalDdlRollback('oracle')).toBe(false);
  });

  it('is false for no-op rollback adapters', () => {
    expect(dialectSupportsTransactionalDdlRollback('redis')).toBe(false);
    expect(dialectSupportsTransactionalDdlRollback('mongodb')).toBe(false);
    expect(dialectSupportsTransactionalDdlRollback('clickhouse')).toBe(false);
  });

  it('is false for CockroachDB, which advertises transactional DDL but does not deliver it', () => {
    // Measured, not assumed. Freshly seeded, demo_b.order_items.qty has
    // DEFAULT 0. The 18-statement compare plan fails on its last statement
    // ("cannot alter type of column qty because view v_order_summary depends
    // on it"), the transaction is rolled back — and qty comes back with no
    // default, left that way by the DROP DEFAULT the plan ran first.
    //
    // Being wrong here is not cosmetic: it is the difference between the UI
    // saying "All changes were rolled back — the target is unchanged" and
    // "Rollback could not be confirmed — verify the target manually".
    expect(dialectSupportsTransactionalDdlRollback('cockroachdb')).toBe(false);
    expect(dialectSupportsTransactionalDdlRollback('CockroachDB')).toBe(false);
  });

  it('is true when schema DDL can participate in a transaction', () => {
    expect(dialectSupportsTransactionalDdlRollback('postgres')).toBe(true);
    expect(dialectSupportsTransactionalDdlRollback('sqlite')).toBe(true);
    expect(dialectSupportsTransactionalDdlRollback('sqlserver')).toBe(true);
    expect(dialectSupportsTransactionalDdlRollback('db2')).toBe(true);
  });
});

describe('the table itself', () => {
  it('takes DML from the provider settings, the flag the browser reads', () => {
    // Data migrate's Transaction checkbox and the editor's One transaction
    // cannot import this package, so they read `transactions` in the provider
    // settings. A second declaration here is how the two would come to
    // disagree about whether a failed migrate was rolled back.
    for (const dialect of DIALECTS) {
      expect(dialectSupportsTransactionalRollback(dialect), dialect).toBe(
        dialectHasTransactions(dialect)
      );
    }
  });

  it('never claims DDL rollback where DML rollback is impossible', () => {
    // An adapter whose rollback does nothing cannot undo DDL either.
    const impossible = DIALECTS.filter(
      (d) => dialectSupportsTransactionalDdlRollback(d) && !dialectSupportsTransactionalRollback(d)
    );
    expect(impossible, 'a no-op rollback cannot undo DDL').toEqual([]);
  });

  it('lists only engines whose DML does roll back', () => {
    // An engine with no transactions loses DDL rollback anyway; listing it
    // here would read as the reason, and hide the one that applies.
    const redundant = [...DDL_AUTOCOMMITS_TABLE].filter((d) => !dialectHasTransactions(d));
    expect(redundant, 'this engine has no transactions at all; remove it').toEqual([]);
  });

  it('answers both questions for an engine it has never heard of', () => {
    expect(dialectSupportsTransactionalRollback('some-new-engine')).toBe(true);
    expect(dialectSupportsTransactionalDdlRollback('some-new-engine')).toBe(true);
  });
});
