/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The `Dialect` union and the `PROVIDER_SETTINGS` registry must list the same
 * engines.
 *
 * This is a test rather than a type-level assertion because it cannot be one:
 * the registry is built with computed keys, which TypeScript widens to `string`,
 * so `Record<Dialect, …>` only type-checks with a cast — and the cast makes it
 * pass no matter what. An assertion that always passes is worse than none; it
 * reads like a guard while guarding nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  DIALECTS,
  PROVIDER_SETTINGS,
  dialectHasTransactions,
  getProviderSettings,
  isFileDialect,
} from './provider-settings.js';

describe('the dialect union matches the registry', () => {
  it('lists exactly the registered dialects', () => {
    expect([...DIALECTS].sort()).toEqual(Object.keys(PROVIDER_SETTINGS).sort());
  });

  it('resolves every listed dialect to settings that name themselves', () => {
    for (const dialect of DIALECTS) {
      expect(getProviderSettings(dialect).dialect, `${dialect} settings disagree on their own name`).toBe(
        dialect
      );
    }
  });

  it('has no duplicates', () => {
    expect(new Set(DIALECTS).size).toBe(DIALECTS.length);
  });
});

describe('isFileDialect', () => {
  it('is true for the engines that are a file on disk', () => {
    expect(isFileDialect('sqlite')).toBe(true);
    expect(isFileDialect('duckdb')).toBe(true);
  });

  it('is false for every server engine', () => {
    for (const dialect of DIALECTS) {
      if (dialect === 'sqlite' || dialect === 'duckdb') continue;
      expect(isFileDialect(dialect), `${dialect} is not a file`).toBe(false);
    }
  });

  it('is case-insensitive, like getProviderSettings', () => {
    expect(isFileDialect('SQLite')).toBe(true);
  });
});

describe('dialectHasTransactions', () => {
  // Their adapters open no transaction, so "one transaction" there commits
  // each statement as it runs and a failure rolls nothing back.
  const NONE = ['clickhouse', 'mongodb', 'redis'];

  it('is false for exactly the engines with nothing to roll back', () => {
    expect(DIALECTS.filter((dialect) => !dialectHasTransactions(dialect)).sort()).toEqual(NONE);
  });

  it('is case-insensitive, and true for a dialect it does not know', () => {
    expect(dialectHasTransactions('ClickHouse')).toBe(false);
    expect(dialectHasTransactions('editor')).toBe(true);
    expect(dialectHasTransactions('')).toBe(true);
  });
});
