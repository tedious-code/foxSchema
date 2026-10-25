import { type ConnectionOptions, type DriverAdapter, parseSqlSubset, subsetValue } from '@foxschema/sql';
import { credentialedCacheKey } from '../../cores/pool-cache.js';
import { requireDriver } from '../../cores/driver-loader.js';
import { COLLECTION_TYPES, JSON_TYPE, readCollection, readKeyRow } from './redis.keyspace.js';

/**
 * Redis behind the SQL editor, for the cache-maintenance case.
 *
 * Redis has no SQL and no tables. The mapping that makes it addressable is:
 *
 *   "table"  → a key prefix, so `users` covers `users:*`
 *   "row"    → one hash at `users:<id>`
 *   "column" → a field of that hash, plus the synthetic `id`
 *
 * Hashes rather than plain strings because a row has named fields, and HSET /
 * HGETALL map onto them exactly. A JSON document (the JSON type, or JSON text in
 * a string) reads as its top-level fields, and a plain string as a single
 * `value`. A list, set, sorted set or stream key is a table of its own, named
 * by the whole key, with its elements as rows (redis.keyspace.ts). Only hashes
 * are written field-wise; everything else is read-only here, and says so.
 *
 * Every statement goes through `parseSqlSubset`; anything outside it is
 * refused. That matters more here than anywhere else, because there is no
 * server-side query engine to catch a mistranslation — a wrong pattern in a
 * DELETE would simply remove different keys.
 *
 * SCAN, never KEYS: KEYS blocks the server for the length of the keyspace, and
 * a cache is exactly where that hurts.
 */

/** `SELECT a, b` keeps those columns, in that order; `SELECT *` keeps every field. */
export function projectColumns(
  rows: Record<string, unknown>[],
  columns: string[] | '*'
): Record<string, unknown>[] {
  if (columns === '*') return rows;
  return rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
}

/** Exported for unit tests — equality check used for non-id WHERE predicates. */
export function redisRowMatchesPredicates(
  row: Record<string, unknown>,
  predicates: ReadonlyArray<{ column: string; value: { kind: string; index?: number; value?: unknown } }>,
  params: readonly unknown[]
): boolean {
  return predicates.every((w) => {
    const expected = subsetValue(w.value as any, params);
    // Null filters are refused by the caller; treat a resolved null as non-match
    // rather than matching every missing/empty field.
    if (expected === null || expected === undefined) return false;
    return String(row[w.column] ?? '') === String(expected);
  });
}

class RedisAdapter implements DriverAdapter {
  readonly dialect = 'redis';
  readonly packageName = 'redis';

  private clients = new Map<string, any>();
  private mod: any;

  private load(): any {
    if (this.mod) return this.mod;
    this.mod = requireDriver(this.packageName, this.dialect);
    return this.mod;
  }

  async acquire(connectionString: string, options: ConnectionOptions, _pooled: boolean): Promise<any> {
    const { createClient } = this.load();
    const key = credentialedCacheKey({
      connectionString,
      username: options.username || '',
      password: options.password || '',
      database: options.database || '0',
    });
    let client = this.clients.get(key);
    if (!client) {
      client = createClient({
        url: connectionString,
        ...(options.username ? { username: options.username } : {}),
        ...(options.password ? { password: options.password } : {}),
      });
      client.on('error', () => {
        // The driver emits on transient drops; throwing here would take the
        // process down. Failures surface on the command itself instead.
      });
      await client.connect();
      this.clients.set(key, client);
    }
    return client;
  }

  async release(_connection: any): Promise<void> {
    // Connections are reused; closeAll disconnects them.
  }

  /** `users` + id `7` → `users:7`. */
  private keyFor(table: string, id: unknown): string {
    return `${table}:${String(id)}`;
  }

  /** Read one key as a row, whatever type it holds. */
  private readRow(client: any, table: string, key: string): Promise<Record<string, unknown> | null> {
    return readKeyRow(client, table, key);
  }

  /** The collection type when `table` names a list, set, sorted set or stream key itself. */
  private async collectionType(client: any, table: string): Promise<string | null> {
    const type = String(await client.type(table));
    return COLLECTION_TYPES.has(type) ? type : null;
  }

  /** Refuse a write addressed to a collection table: its elements are read-only here. */
  private async refuseCollectionWrite(client: any, table: string): Promise<void> {
    const type = await this.collectionType(client, table);
    if (type) {
      throw new Error(`Redis: "${table}" is a ${type}; its elements are read-only here.`);
    }
  }

  async query<T = Record<string, unknown>>(
    connection: any,
    sql: string,
    params: readonly unknown[]
  ): Promise<T[]> {
    const parsed = parseSqlSubset(sql);
    if (!parsed.ok) throw new Error(`Redis: ${parsed.error}`);
    const intent = parsed.intent;
    const client = connection;

    const idFrom = (
      pairs: ReadonlyArray<{ column: string; value: any }>
    ): unknown | undefined => {
      const hit = pairs.find((p) => p.column === 'id');
      return hit ? subsetValue(hit.value, params) : undefined;
    };

    const extraWhere = (pairs: ReadonlyArray<{ column: string; value: any }>) =>
      pairs.filter((w) => w.column !== 'id');

    switch (intent.kind) {
      case 'select': {
        // An empty page (past the end of the reader's own LIMIT) reads nothing.
        if (intent.limit === 0) return [] as T[];
        const project = (rows: Record<string, unknown>[]) => projectColumns(rows, intent.columns);

        const collection = await this.collectionType(client, intent.table);
        if (collection) {
          return project(
            await readCollection(client, intent.table, collection, {
              offset: intent.offset ?? 0,
              limit: intent.limit ?? 100,
              matches: (row) => redisRowMatchesPredicates(row, intent.where, params),
              filtered: intent.where.length > 0,
            })
          ) as T[];
        }

        const id = idFrom(intent.where);
        const extra = extraWhere(intent.where);
        if (id !== undefined) {
          const row = await this.readRow(client, intent.table, this.keyFor(intent.table, id));
          if (!row || (intent.offset ?? 0) > 0) return [] as T[];
          // Non-id predicates must still hold — otherwise `WHERE id = 1 AND
          // status = 'active'` would return the inactive row.
          if (!redisRowMatchesPredicates(row, extra, params)) return [] as T[];
          return project([row]) as T[];
        }
        // No id: scan the prefix. Bounded by LIMIT so browsing a large cache
        // cannot walk the whole keyspace. Filter *before* counting toward the
        // limit, or `WHERE name = ? LIMIT 2` would sample the first two keys
        // and then discard non-matches.
        const limit = intent.limit ?? 100;
        let skip = intent.offset ?? 0;
        const rows: Record<string, unknown>[] = [];
        // node-redis v6 yields a *batch* of keys per iteration; older clients
        // yielded one key. Normalising both is not defensive noise — assuming
        // the single-key shape made String(['a','b']) the key, so every scan
        // silently returned nothing.
        outer: for await (const batch of client.scanIterator({
          MATCH: `${intent.table}:*`,
          COUNT: 200,
        })) {
          const keys: string[] = Array.isArray(batch)
            ? batch.map((k) => String(k))
            : [String(batch)];
          for (const k of keys) {
            const row = await this.readRow(client, intent.table, k);
            if (!row) continue;
            if (!redisRowMatchesPredicates(row, extra, params)) continue;
            if (skip > 0) {
              skip--;
              continue;
            }
            rows.push(row);
            if (rows.length >= limit) break outer;
          }
        }
        return project(rows) as T[];
      }
      case 'insert': {
        await this.refuseCollectionWrite(client, intent.table);
        const doc: Record<string, string> = {};
        let id: unknown;
        for (const a of intent.assignments) {
          const value = subsetValue(a.value, params);
          if (a.column === 'id') id = value;
          else doc[a.column] = value === null || value === undefined ? '' : String(value);
        }
        if (id === undefined) throw new Error('Redis: INSERT needs an `id` column to form the key.');
        const key = this.keyFor(intent.table, id);
        if (Object.keys(doc).length > 0) await client.hSet(key, doc);
        else await client.hSet(key, { id: String(id) });
        return [{ rowCount: 1, key }] as T[];
      }
      case 'update': {
        const id = idFrom(intent.where);
        if (id === undefined) {
          throw new Error('Redis: UPDATE needs `id` in the WHERE clause to address a key.');
        }
        await this.refuseCollectionWrite(client, intent.table);
        const key = this.keyFor(intent.table, id);
        const row = await this.readRow(client, intent.table, key);
        if (!row) return [{ rowCount: 0 }] as T[];
        // A JSON document or a string reads as fields too, but HSET on it is
        // WRONGTYPE. Say what it is instead of failing with that.
        const type = String(await client.type(key));
        if (type !== 'hash') {
          const what = type === JSON_TYPE ? 'JSON document' : type;
          throw new Error(`Redis: "${key}" is a ${what}; only hash keys are updated field by field.`);
        }
        // Must honour every AND predicate. Ignoring `status = 'active'` here
        // would overwrite a key the WHERE clause excluded — silent data loss.
        if (!redisRowMatchesPredicates(row, extraWhere(intent.where), params)) {
          return [{ rowCount: 0 }] as T[];
        }
        const set: Record<string, string> = {};
        for (const s of intent.set) {
          if (s.column === 'id') continue; // renaming the key is not an update
          const value = subsetValue(s.value, params);
          set[s.column] = value === null || value === undefined ? '' : String(value);
        }
        if (Object.keys(set).length > 0) await client.hSet(key, set);
        return [{ rowCount: 1, key }] as T[];
      }
      case 'delete': {
        const id = idFrom(intent.where);
        if (id === undefined) {
          throw new Error('Redis: DELETE needs `id` in the WHERE clause to address a key.');
        }
        await this.refuseCollectionWrite(client, intent.table);
        const key = this.keyFor(intent.table, id);
        const row = await this.readRow(client, intent.table, key);
        if (!row) return [{ rowCount: 0 }] as T[];
        // Same rule as UPDATE: `DELETE … WHERE id = 1 AND status = 'active'`
        // must not remove an inactive row.
        if (!redisRowMatchesPredicates(row, extraWhere(intent.where), params)) {
          return [{ rowCount: 0 }] as T[];
        }
        const removed = await client.del(key);
        return [{ rowCount: removed }] as T[];
      }
    }
  }

  // Redis MULTI is not a rollback-capable transaction: queued commands cannot
  // be undone once EXEC runs. Pretending otherwise would make a failed migrate
  // claim it rolled back when it did not.
  async beginTransaction(_connection: any): Promise<void> {}
  async commitTransaction(_connection: any): Promise<void> {}
  async rollbackTransaction(_connection: any): Promise<void> {}

  async setCurrentSchema(connection: any, schema: string): Promise<void> {
    const n = Number(schema);
    if (Number.isInteger(n) && n >= 0) await connection.select(n);
  }

  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  }
}

export const redisAdapter = new RedisAdapter();
