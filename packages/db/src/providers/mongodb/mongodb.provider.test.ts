/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Collections as the tables the explorer lists. Before this provider, testing
 * a Mongo connection failed: "No provider registered for dialect: mongodb".
 */
import { describe, expect, it } from 'vitest';
import { dbSchemaToTableSchemas } from '@foxschema/sql';
import { PROVIDERS } from '../provider-registry.js';
import { dbSchemaFromCollections } from './mongodb.provider.js';

describe('MongoDB schema provider', () => {
  it('is registered, so a Mongo connection can be tested', () => {
    expect(PROVIDERS.mongodb?.provider).toBe('mongodb');
  });

  it('lists every collection as a table with _id as the key', () => {
    const tables = dbSchemaToTableSchemas(
      dbSchemaFromCollections([
        { name: 'users', fields: ['_id', 'email', 'name'] },
        { name: 'orders', fields: ['sku'] },
      ])
    );
    expect(tables.map((t) => [t.name, t.primaryKey?.columns, t.columns.map((c) => c.name)])).toEqual([
      ['orders', ['_id'], ['_id', 'sku']],
      ['users', ['_id'], ['_id', 'email', 'name']],
    ]);
  });
});
