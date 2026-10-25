/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Redis schema browsing: the keyspace as tables (redis.keyspace.ts).
 *
 * Without this, loading a Redis connection's schema failed with "No provider
 * registered for dialect: redis", so the explorer listed nothing — not the
 * prefixes the SQL editor could already query, and not the lists, sets and
 * JSON documents it could not.
 *
 * It is a browsing aid, not a catalog: Redis has no schema, so the tables come
 * from a bounded SCAN sample, and a table says when the keyspace was larger
 * than the sample. Schema compare and history stay refused for Redis
 * (`schemaCompareSupport`): a sampled keyspace is not a schema to diff.
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
import { redisAdapter } from './redis.adapter.js';
import { sampleKeyspace, type KeyspaceSample } from './redis.keyspace.js';

const DIALECT = 'redis';

/** Column types as the explorer shows them. Redis stores text; index and score are numbers. */
function columnType(name: string, storeType: string): string {
  if (name === 'index' && storeType === 'list') return 'integer';
  if (name === 'score' && storeType === 'zset') return 'double';
  return 'text';
}

/** Database numbers that hold keys, from `INFO keyspace` (`db3:keys=12,…`). */
export function databasesFromInfo(info: string): string[] {
  const dbs = new Set(['0']);
  for (const line of info.split(/\r?\n/)) {
    const m = /^db(\d+):keys=/.exec(line.trim());
    if (m) dbs.add(m[1]!);
  }
  return [...dbs].sort((a, b) => Number(a) - Number(b));
}

/** A keyspace sample as the schema shape every provider returns. */
export function dbSchemaFromSample(sample: KeyspaceSample): DbSchema {
  const tables: Record<string, DbTable> = {};
  const columns: Record<string, DbColumn[]> = {};
  const primaryKeys: DbSchema['primaryKeys'] = {};

  for (const t of sample.tables) {
    const cols = t.columns.map(
      (name): DbColumn => ({ name, type: columnType(name, t.storeType), nullable: name !== 'id' })
    );
    // Only a hash prefix is written row by row (by `id`); a primary key on
    // anything else would offer edits the adapter refuses.
    const pk = t.kind === 'prefix' && t.storeType === 'hash' ? ['id'] : [];
    tables[t.name] = {
      name: t.name,
      columns: Object.fromEntries(cols.map((c) => [c.name, c])),
      primaryKey: pk,
      foreignKeys: [],
      uniqueConstraints: [],
      indexes: [],
      storeType: t.storeType,
    };
    columns[t.name] = cols;
    if (pk.length) primaryKeys[t.name] = [{ name: t.name, constName: `${t.name}_key`, column: 'id', colSeq: 1 }];
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

export class RedisProvider implements SchemaProvider {
  readonly provider = DIALECT;

  /** Run `fn` on a client switched to `schema` (the database number). */
  private async withClient<T>(options: ConnectionOptions, schema: string, fn: (client: any) => Promise<T>): Promise<T> {
    const client = await ConnectionFactory.create(DIALECT, options);
    try {
      const db = (schema || options.schema || '').trim();
      if (db) await redisAdapter.setCurrentSchema(client, db);
      return await fn(client);
    } finally {
      await ConnectionFactory.close(DIALECT, client);
    }
  }

  async testConnection(options: ConnectionOptions): Promise<boolean> {
    try {
      return await this.withClient(options, '', async (client) => (await client.ping()) === 'PONG');
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  }

  async listSchemas(options: ConnectionOptions): Promise<string[]> {
    return this.withClient(options, '', async (client) => databasesFromInfo(String(await client.info('keyspace'))));
  }

  async getTables(options: ConnectionOptions, schema: string): Promise<TableSchema[]> {
    return dbSchemaToTableSchemas(await this.loadSchema(options, schema));
  }

  async loadSchema(options: ConnectionOptions, schema: string): Promise<DbSchema> {
    return dbSchemaFromSample(await this.withClient(options, schema, (client) => sampleKeyspace(client)));
  }

}
