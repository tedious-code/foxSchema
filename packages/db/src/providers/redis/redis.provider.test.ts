/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A Redis keyspace as the tables the explorer lists. Before this provider,
 * loading a Redis schema failed: "No provider registered for dialect: redis".
 */
import { describe, expect, it } from 'vitest';
import { dbSchemaToTableSchemas } from '@foxschema/sql';
import { PROVIDERS } from '../provider-registry.js';
import { databasesFromInfo, dbSchemaFromSample } from './redis.provider.js';
import type { KeyspaceSample } from './redis.keyspace.js';

const sample: KeyspaceSample = {
  sampled: false,
  tables: [
    { name: 'users', storeType: 'hash', kind: 'prefix', columns: ['id', 'name'] },
    { name: 'docs', storeType: 'json', kind: 'prefix', columns: ['id', 'title'] },
    { name: 'queue:jobs', storeType: 'list', kind: 'collection', columns: ['index', 'value', 'job'] },
    { name: 'board', storeType: 'zset', kind: 'collection', columns: ['member', 'score'] },
  ],
};

describe('Redis schema provider', () => {
  it('is registered, so a Redis schema loads instead of failing', () => {
    expect(PROVIDERS.redis?.provider).toBe('redis');
  });

  it('lists every table with its store type, for the explorer badge', () => {
    const tables = dbSchemaToTableSchemas(dbSchemaFromSample(sample));
    // Listed by name, as every provider's tables are.
    expect(tables.map((t) => [t.name, t.storeType, t.objectType])).toEqual([
      ['board', 'zset', 'TABLE'],
      ['docs', 'json', 'TABLE'],
      ['queue:jobs', 'list', 'TABLE'],
      ['users', 'hash', 'TABLE'],
    ]);
  });

  it('gives only a hash prefix a primary key — the one kind the adapter writes row by row', () => {
    const tables = Object.fromEntries(dbSchemaToTableSchemas(dbSchemaFromSample(sample)).map((t) => [t.name, t]));
    expect(tables.users!.primaryKey?.columns).toEqual(['id']);
    expect(tables.docs!.primaryKey).toBeUndefined();
    expect(tables['queue:jobs']!.primaryKey).toBeUndefined();
  });

  it('types a list index and a sorted-set score as numbers, everything else as text', () => {
    const tables = Object.fromEntries(dbSchemaToTableSchemas(dbSchemaFromSample(sample)).map((t) => [t.name, t]));
    expect(tables['queue:jobs']!.columns.map((c) => c.type)).toEqual(['integer', 'text', 'text']);
    expect(tables.board!.columns.map((c) => c.type)).toEqual(['text', 'double']);
  });

  it('lists the databases that hold keys, and always database 0', () => {
    expect(databasesFromInfo('# Keyspace\r\ndb0:keys=5,expires=0\r\ndb3:keys=2,expires=1\r\n')).toEqual(['0', '3']);
    expect(databasesFromInfo('# Keyspace\r\n')).toEqual(['0']);
  });
});
