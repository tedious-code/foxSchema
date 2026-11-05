/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * MongoDB schema browsing: collections as tables.
 *
 * Without this, testing a Mongo connection failed with "No provider registered
 * for dialect: mongodb" after the driver itself loaded. Schema compare and
 * history stay refused (`schemaCompareSupport`): a collection is not a table
 * to diff.
 */
import { ConnectionFactory } from '../../cores/connection-factory.js';
import {
  dbSchemaToTableSchemas,
  errorMessage,
  type ConnectionOptions,
  type DbColumn,
  type DbSchema,
  type DbTable,
  type SchemaProvider,
  type TableSchema,
} from '@foxschema/sql';
import { mongoDbAdapter } from './mongodb.adapter.js';

const DIALECT = 'mongodb';

export type CollectionSample = { name: string; fields: string[] };

/** Collections and sampled field names as the schema shape every provider returns. */
export function dbSchemaFromCollections(collections: CollectionSample[]): DbSchema {
  const tables: Record<string, DbTable> = {};
  const columns: Record<string, DbColumn[]> = {};
  const primaryKeys: DbSchema['primaryKeys'] = {};

  for (const c of collections) {
    const names = c.fields.includes('_id') ? c.fields : ['_id', ...c.fields];
    const cols = names.map(
      (name): DbColumn => ({ name, type: name === '_id' ? 'objectId' : 'text', nullable: name !== '_id' })
    );
    tables[c.name] = {
      name: c.name,
      columns: Object.fromEntries(cols.map((col) => [col.name, col])),
      primaryKey: ['_id'],
      foreignKeys: [],
      uniqueConstraints: [],
      indexes: [],
    };
    columns[c.name] = cols;
    primaryKeys[c.name] = [{ name: c.name, constName: `${c.name}_id`, column: '_id', colSeq: 1 }];
  }

  return {
    tables,
    columns,
    functions: {},
    procedures: {},
    triggers: {},
    sequences: {},
    userTypes: {},
    primaryKeys,
    foreignKeys: {},
    views: {},
    uniqueConstraints: {},
    indexes: {},
    indexColumns: {},
  };
}

export class MongoDbProvider implements SchemaProvider {
  readonly provider = DIALECT;

  private async withHandle<T>(
    options: ConnectionOptions,
    schema: string,
    fn: (handle: { client: any; database: string }) => Promise<T>
  ): Promise<T> {
    const handle = await ConnectionFactory.create(DIALECT, options);
    try {
      const db = (schema || options.database || options.schema || '').trim();
      if (db) await mongoDbAdapter.setCurrentSchema(handle, db);
      return await fn(handle);
    } finally {
      await ConnectionFactory.close(DIALECT, handle);
    }
  }

  async testConnection(options: ConnectionOptions): Promise<boolean> {
    try {
      return await this.withHandle(options, '', async (handle) => {
        await handle.client.db('admin').command({ ping: 1 });
        return true;
      });
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  async listSchemas(options: ConnectionOptions): Promise<string[]> {
    return this.withHandle(options, '', async (handle) => {
      try {
        const listed = await handle.client.db('admin').admin().listDatabases();
        const names = (listed?.databases ?? [])
          .map((d: { name?: string }) => d.name)
          .filter((n: unknown): n is string => typeof n === 'string' && n !== 'admin' && n !== 'local' && n !== 'config');
        if (names.length) return names.sort();
      } catch {
        // A user that cannot listDatabases still has the database on the URI.
      }
      const fallback = (options.database || options.schema || handle.database || 'test').trim();
      return fallback ? [fallback] : ['test'];
    });
  }

  async getTables(options: ConnectionOptions, schema: string): Promise<TableSchema[]> {
    return dbSchemaToTableSchemas(await this.loadSchema(options, schema));
  }

  async loadSchema(options: ConnectionOptions, schema: string): Promise<DbSchema> {
    return dbSchemaFromCollections(
      await this.withHandle(options, schema, async (handle) => {
        const db = handle.client.db(handle.database);
        const listed = await db.listCollections().toArray();
        const collections: CollectionSample[] = [];
        for (const entry of listed) {
          const name = String(entry.name ?? '');
          if (!name) continue;
          const sample = await db.collection(name).findOne();
          const fields = sample ? Object.keys(sample) : ['_id'];
          collections.push({ name, fields });
        }
        return collections;
      })
    );
  }

  async detectVersion(options: ConnectionOptions): Promise<string> {
    return this.withHandle(options, '', async (handle) => {
      const info = await handle.client.db('admin').command({ buildInfo: 1 });
      return String(info?.version ?? '');
    });
  }
}
