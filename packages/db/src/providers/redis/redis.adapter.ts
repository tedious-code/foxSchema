import { type ConnectionOptions, type DriverAdapter, parseSqlSubset, subsetValue } from '@foxschema/sql';
import { BoundedPoolCache, credentialedCacheKey } from '../../cores/pool-cache.js';
import { requireDriver } from '../../cores/driver-loader.js';

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
 * HGETALL map onto them exactly. A key holding a plain string is reported as a
 * single `value` field so browsing still works, but it cannot be updated
 * field-wise — that is stated, not silently approximated.
 *
 * Every statement goes through `parseSqlSubset`; anything outside it is
 * refused. That matters more here than anywhere else, because there is no
 * server-side query engine to catch a mistranslation — a wrong pattern in a
 * DELETE would simply remove different keys.
 *
 * SCAN, never KEYS: KEYS blocks the server for the length of the keyspace, and
 * a cache is exactly where that hurts.
 */

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

  private clients = new BoundedPoolCache<any>((c) =>
    typeof c.quit === 'function' ? c.quit().catch(() => undefined) : Promise.resolve()
  );
  private mod: any;

  private load(): any {
    if (this.mod) return this.mod;
    this.mod = requireDriver(this.packageName, this.dialect);
    return this.mod;
  }

  async acquire(connectionString: string, options: ConnectionOptions, _pooled: boolean): Promise<any> {
    const { createClient } = this.load();
    const database = options.database || '0';
    const key = credentialedCacheKey({
      connectionString,
      username: options.username || '',
      password: options.password || '',
      database,
    });
    const client = await this.clients.getOrCreate(key, async () => {
      const created = createClient({
        url: connectionString,
        ...(options.username ? { username: options.username } : {}),
        ...(options.password ? { password: options.password } : {}),
      });
      created.on('error', () => {
        // The driver emits on transient drops; throwing here would take the
        // process down. Failures surface on the command itself instead.
      });
      await created.connect();
      return created;
    });
    // Reset selected DB index on acquire so a previous caller's setCurrentSchema
    // does not leave the shared socket pointed at a different database index.
    const dbIndex = Number(database);
    if (Number.isInteger(dbIndex) && dbIndex >= 0 && typeof client.select === 'function') {
      await client.select(dbIndex);
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
  private async readRow(
    client: any,
    table: string,
    key: string
  ): Promise<Record<string, unknown> | null> {
    const type = await client.type(key);
    const id = key.startsWith(`${table}:`) ? key.slice(table.length + 1) : key;
    if (type === 'hash') {
      const hash = await client.hGetAll(key);
      if (!hash || Object.keys(hash).length === 0) return null;
      return { id, ...hash };
    }
    if (type === 'string') {
      const value = await client.get(key);
      return value === null ? null : { id, value };
    }
    // list/set/zset/stream have no row shape; report the type rather than
    // inventing columns for them.
    return type === 'none' ? null : { id, type };
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
        const id = idFrom(intent.where);
        const extra = extraWhere(intent.where);
        if (id !== undefined) {
          const row = await this.readRow(client, intent.table, this.keyFor(intent.table, id));
          if (!row) return [] as T[];
          // Non-id predicates must still hold — otherwise `WHERE id = 1 AND
          // status = 'active'` would return the inactive row.
          if (!redisRowMatchesPredicates(row, extra, params)) return [] as T[];
          return [row] as T[];
        }
        // No id: scan the prefix. Bounded by LIMIT so browsing a large cache
        // cannot walk the whole keyspace. Filter *before* counting toward the
        // limit, or `WHERE name = ? LIMIT 2` would sample the first two keys
        // and then discard non-matches.
        const limit = intent.limit ?? 100;
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
            rows.push(row);
            if (rows.length >= limit) break outer;
          }
        }
        return rows as T[];
      }
      case 'insert': {
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
        const key = this.keyFor(intent.table, id);
        const row = await this.readRow(client, intent.table, key);
        if (!row) return [{ rowCount: 0 }] as T[];
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
    await this.clients.clear();
  }
}

export const redisAdapter = new RedisAdapter();
