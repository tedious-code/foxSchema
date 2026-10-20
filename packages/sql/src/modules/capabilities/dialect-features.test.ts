/**
 * Fox Schema (@foxschema/sql)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * There is no consistency test beside this one any more, and that is the
 * point: the first version of this table re-declared four answers it could not
 * import, so a second test existed only to police the copy. The table derives
 * them now, and cannot disagree with itself.
 *
 * What is left to test is the derivation itself, the reasons nothing else
 * owns, and the safe default.
 */
import { describe, expect, it } from 'vitest';
import {
  DIALECT_FEATURES,
  dialectFeatureReason,
  dialectFeatures,
  knownDialects,
  schemaCompareBlocker,
  supportsDialectFeature,
} from './dialect-features.js';
import { DIALECT_MAP } from '../dialect/registry.js';
import { PROVIDER_SETTINGS, dialectHasTransactions } from '../../providers/provider-settings.js';

describe('every engine a connection can use gets an answer', () => {
  it('covers the provider roster, not a second hand-written list', () => {
    // A new engine registered in PROVIDER_SETTINGS used to fall through as
    // unknown and lose every feature with nothing failing.
    expect(knownDialects()).toEqual(Object.keys(PROVIDER_SETTINGS).sort());
  });

  it('answers each feature, and explains every no', () => {
    for (const dialect of knownDialects()) {
      const features = dialectFeatures(dialect);
      for (const feature of DIALECT_FEATURES) {
        expect(typeof features[feature]?.supported, `${dialect}.${feature}`).toBe('boolean');
        if (!features[feature].supported) {
          expect(features[feature].reason, `${dialect}.${feature}`).toBeTruthy();
        }
      }
    }
  });

  it('says nothing when the answer is yes', () => {
    expect(dialectFeatureReason('postgres', 'schemaCompare')).toBeUndefined();
    expect(dialectFeatures('postgres').schemaCompare).toEqual({ supported: true });
  });
});

describe('the answers are asked for, not copied', () => {
  it('offers schema compare to exactly the engines with a SQL dialect', () => {
    const withDialect = new Set(Object.keys(DIALECT_MAP).map((d) => d.toLowerCase()));
    for (const dialect of knownDialects()) {
      expect(supportsDialectFeature(dialect, 'schemaCompare'), dialect).toBe(
        withDialect.has(dialect)
      );
    }
  });

  it('takes User Management’s own per-engine wording rather than inventing one', () => {
    // It has carried a reason since long before this table; re-typing it was
    // how the app came to say two different sentences for one refusal.
    expect(dialectFeatureReason('redis', 'userManagement')).toMatch(/redis-cli/);
    expect(dialectFeatureReason('mongodb', 'userManagement')).toMatch(/mongosh/);
    expect(dialectFeatureReason('sqlite', 'userManagement')).toMatch(/no database accounts/i);
  });

  it('takes the access wording from the access module too', () => {
    expect(dialectFeatureReason('redis', 'dbAccess')).toMatch(/redis-cli/);
    expect(dialectFeatureReason('mongodb', 'dbAccess')).toMatch(/mongosh/);
  });

  it('offers transactions exactly where the provider settings have them', () => {
    // The same flag the editor's One transaction reads, and the one
    // `@foxschema/db` answers DML rollback from. Data migrate's Transaction
    // checkbox defaulted on for Redis and promised a rollback of the whole
    // batch; its adapter's ROLLBACK does nothing.
    for (const dialect of knownDialects()) {
      expect(supportsDialectFeature(dialect, 'transactions'), dialect).toBe(
        dialectHasTransactions(dialect)
      );
    }
    for (const dialect of ['redis', 'mongodb', 'clickhouse', 'Redis']) {
      expect(supportsDialectFeature(dialect, 'transactions'), dialect).toBe(false);
    }
    for (const dialect of ['postgres', 'mysql', 'oracle', 'sqlite', 'cockroachdb']) {
      expect(supportsDialectFeature(dialect, 'transactions'), dialect).toBe(true);
    }
  });
});

describe('the reasons this table owns', () => {
  /**
   * Who is at fault, per engine, for every engine that has no access builder.
   *
   * Deriving the flag and guessing one sentence for all of them regressed this
   * once already: SQLite was told "Fox Schema has no permission builder yet",
   * which implies one could be built. It cannot — SQLite has no grants at all.
   * The previous test checked ClickHouse only, so the inversion slipped past.
   *
   * Written as a table that must cover every refusing engine, so adding one
   * forces the question rather than inheriting whichever sentence came last.
   */
  const ACCESS_BLAME: Record<string, { names: RegExp; notThe: RegExp }> = {
    // Fox Schema's gap: ClickHouse really does accept GRANT.
    clickhouse: { names: /Fox Schema has no permission builder/i, notThe: /ClickHouse has no/i },
    // The engine's own nature: a file's permissions are the access control.
    sqlite: { names: /SQLite has no grants/i, notThe: /Fox Schema has no permission builder/i },
    duckdb: { names: /DuckDB has no grants/i, notThe: /Fox Schema has no permission builder/i },
    // Real permissions, reachable only outside SQL — so name the tool.
    redis: { names: /redis-cli/, notThe: /has no grants/i },
    mongodb: { names: /mongosh/, notThe: /has no grants/i },
  };

  it('blames the right party for every engine with no access builder', () => {
    const refusing = knownDialects().filter((d) => !supportsDialectFeature(d, 'dbAccess'));
    expect(refusing.sort()).toEqual(Object.keys(ACCESS_BLAME).sort());

    for (const [dialect, { names, notThe }] of Object.entries(ACCESS_BLAME)) {
      const reason = dialectFeatureReason(dialect, 'dbAccess')!;
      expect(reason, dialect).toMatch(names);
      expect(reason, dialect).not.toMatch(notThe);
    }
  });

  /**
   * Who cannot roll back, per engine. The sentence is the tooltip on a
   * disabled Transaction checkbox, so it must say where the gap is: Redis has
   * no rollback to offer, while MongoDB does on a replica set and Fox Schema
   * is what leaves it unused. A shared "X has no transactions" is wrong for
   * MongoDB.
   */
  const TRANSACTION_BLAME: Record<string, { names: RegExp; notThe: RegExp }> = {
    redis: { names: /Redis cannot undo a write/, notThe: /Fox Schema/ },
    mongodb: { names: /Fox Schema writes to MongoDB without a transaction/, notThe: /MongoDB has no/i },
    clickhouse: { names: /ClickHouse transactions are experimental/, notThe: /ClickHouse has no/i },
  };

  it('blames the right party for every engine with no transactions', () => {
    const refusing = knownDialects().filter((d) => !supportsDialectFeature(d, 'transactions'));
    expect(refusing.sort()).toEqual(Object.keys(TRANSACTION_BLAME).sort());

    for (const [dialect, { names, notThe }] of Object.entries(TRANSACTION_BLAME)) {
      const reason = dialectFeatureReason(dialect, 'transactions')!;
      expect(reason, dialect).toMatch(names);
      expect(reason, dialect).not.toMatch(notThe);
      // What the user is deciding about: rows that already went in.
      expect(reason, dialect).toMatch(/rows written before it/);
    }
  });

  it('names the engine properly, not by its connection id', () => {
    expect(dialectFeatureReason('mongodb', 'schemaCompare')).toMatch(/MongoDB/);
    expect(dialectFeatureReason('clickhouse', 'rowEditing')).toMatch(/ClickHouse/);
  });

  it('keeps row editing for the engines whose adapters write', () => {
    // SQLite's adapter opens read-write on purpose — a stale list elsewhere
    // called it read-only and sent readers looking for a problem that was not
    // there. ClickHouse is the only one that really rejects writes.
    for (const dialect of ['sqlite', 'redis', 'mongodb', 'postgres']) {
      expect(supportsDialectFeature(dialect, 'rowEditing'), dialect).toBe(true);
    }
    expect(supportsDialectFeature('clickhouse', 'rowEditing')).toBe(false);
  });
});

describe('an engine nobody added supports nothing', () => {
  // The opposite of `resolveDialect`, which answers Db2 for an unknown name —
  // the fallback that let a Redis connection reach Schema Compare.
  it('refuses every feature and names the engine', () => {
    for (const feature of DIALECT_FEATURES) {
      expect(supportsDialectFeature('dynamodb', feature), feature).toBe(false);
    }
    expect(dialectFeatureReason('dynamodb', 'schemaCompare')).toMatch(/dynamodb/);
  });

  it('treats an empty name as unknown rather than defaulting', () => {
    expect(supportsDialectFeature('', 'dbAccess')).toBe(false);
    expect(dialectFeatureReason('', 'dbAccess')).toMatch(/this engine/i);
  });
});

describe('schemaCompareBlocker answers for a pair', () => {
  it('passes two comparable engines', () => {
    expect(schemaCompareBlocker('postgres', 'mysql')).toBeNull();
  });

  it('names which side is at fault', () => {
    expect(schemaCompareBlocker('redis', 'postgres')).toMatch(/^Source: Redis/);
    expect(schemaCompareBlocker('postgres', 'mongodb')).toMatch(/^Target: MongoDB/);
  });

  it('reports the source first when both are blocked', () => {
    expect(schemaCompareBlocker('redis', 'mongodb')).toMatch(/^Source:/);
  });
});

describe('the record is shared and frozen', () => {
  it('returns the same object for the same engine', () => {
    // One caller sits in a component that re-renders on every checkbox.
    expect(dialectFeatures('postgres')).toBe(dialectFeatures('postgres'));
    expect(dialectFeatures('POSTGRES')).toBe(dialectFeatures('postgres'));
  });

  it('cannot be mutated by one caller for everyone else', () => {
    const features = dialectFeatures('postgres') as Record<string, unknown>;
    expect(() => {
      features.schemaCompare = { supported: false, reason: 'nope' };
    }).toThrow();
  });
});
