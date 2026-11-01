import { type ConnectionOptions, type DriverAdapter, parseSqlSubset, subsetValue } from '@foxschema/sql';
import { credentialedCacheKey } from '../../cores/pool-cache.js';
import { connectTimeoutMs } from '../../cores/timeouts.js';
import { requireDriver } from '../../cores/driver-loader.js';

/**
 * MongoDB behind the SQL editor.
 *
 * Mongo does not speak SQL — the driver takes MQL documents — so every
 * statement is parsed by `parseSqlSubset` and carried out as a collection
 * operation. The subset is small on purpose: anything it cannot represent
 * exactly is refused rather than approximated, because a predicate quietly
 * dropped from a DELETE empties a collection.
 *
 * A collection is a "table" and a document field is a "column". That mapping
 * is honest for the data-migrate case, which only ever addresses a single
 * table by equality on key columns.
 *
 * Transactions are no-ops. Mongo has them, but only on a replica set — a
 * standalone server rejects `startTransaction`, and quietly running a
 * migration unwrapped is better than failing every standalone deployment.
 * `executeDataMigrateOps` already reports per-op results, so a partial run is
 * visible rather than silent.
 */
/** The text of an ObjectId, as a SELECT shows `_id`. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

class MongoDbAdapter implements DriverAdapter {
  readonly dialect = 'mongodb';
  readonly packageName = 'mongodb';

  private clients = new Map<string, any>();
  private mod: any;

  private load(): any {
    if (this.mod) return this.mod;
    this.mod = requireDriver(this.packageName, this.dialect);
    return this.mod;
  }

  async acquire(connectionString: string, options: ConnectionOptions, _pooled: boolean): Promise<any> {
    const { MongoClient } = this.load();
    const database = options.database || options.schema || 'test';
    const key = credentialedCacheKey({
      connectionString,
      username: options.username || '',
      password: options.password || '',
      database,
    });
    let entry = this.clients.get(key);
    if (!entry) {
      const client = new MongoClient(connectionString, {
        serverSelectionTimeoutMS: connectTimeoutMs(options, 10_000),
      });
      await client.connect();
      entry = { client, database };
      this.clients.set(key, entry);
    }
    // Return a per-acquire handle. setCurrentSchema mutates `database` on the
    // handle; sharing the cached object would leave later acquires pointed at
    // whichever database the previous caller switched to.
    return { client: entry.client, database: entry.database };
  }

  async release(_connection: any): Promise<void> {
    // Clients are pooled by the driver and reused; closing happens in closeAll.
  }

  async query<T = Record<string, unknown>>(
    connection: any,
    sql: string,
    params: readonly unknown[]
  ): Promise<T[]> {
    const parsed = parseSqlSubset(sql);
    if (!parsed.ok) {
      // Refuse, with the reason. Never fall back to "run something similar".
      throw new Error(`MongoDB: ${parsed.error}`);
    }
    const intent = parsed.intent;
    const db = connection.client.db(connection.database);
    const collection = db.collection(intent.table);
    const filter = (
      pairs: ReadonlyArray<{ column: string; value: any }>,
      /** Writes must not send `{ field: null }` — Mongo matches missing fields. */
      refuseNull: boolean
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const p of pairs) {
        const v = subsetValue(p.value, params);
        if (refuseNull && (v === null || v === undefined)) {
          throw new Error(
            `MongoDB: refusing a ${intent.kind} whose WHERE binds NULL for "${p.column}" ` +
              `(MongoDB matches missing fields as null).`
          );
        }
        out[p.column] = this.matchValue(p.column, v);
      }
      return out;
    };

    switch (intent.kind) {
      case 'select': {
        // Mongo adds _id to every projection unless told not to; return only
        // the columns the SELECT names.
        const projection =
          intent.columns === '*'
            ? undefined
            : {
                ...Object.fromEntries(intent.columns.map((c) => [c, 1])),
                ...(intent.columns.includes('_id') ? {} : { _id: 0 }),
              };
        // `limit(0)` means "no limit" to Mongo. An empty page (past the end of
        // the reader's own LIMIT) must return nothing, not the collection.
        if (intent.limit === 0) return [] as T[];
        let cursor = collection.find(filter(intent.where, false), { projection });
        if (intent.offset) cursor = cursor.skip(intent.offset);
        if (intent.limit !== undefined) cursor = cursor.limit(intent.limit);
        const docs = await cursor.toArray();
        // _id is a BSON ObjectId — the grid and the diff both want text.
        return docs.map((d: Record<string, unknown>) => ({
          ...d,
          ...(d._id !== undefined ? { _id: String(d._id) } : {}),
        })) as T[];
      }
      case 'insert': {
        const doc: Record<string, unknown> = {};
        for (const a of intent.assignments) doc[a.column] = subsetValue(a.value, params);
        const res = await collection.insertOne(doc);
        return [{ insertedId: String(res.insertedId), rowCount: 1 }] as T[];
      }
      case 'update': {
        const set: Record<string, unknown> = {};
        for (const s of intent.set) set[s.column] = subsetValue(s.value, params);
        const res = await collection.updateMany(filter(intent.where, true), { $set: set });
        return [{ rowCount: res.modifiedCount, matched: res.matchedCount }] as T[];
      }
      case 'delete': {
        const res = await collection.deleteMany(filter(intent.where, true));
        return [{ rowCount: res.deletedCount }] as T[];
      }
    }
  }

  /**
   * A WHERE value as Mongo should match it. A SELECT shows `_id` as text (see
   * the select case), so the same text must find the document again: match
   * the ObjectId it came from as well as a string `_id` with that value.
   * Still exact equality, on either representation.
   */
  private matchValue(column: string, value: unknown): unknown {
    if (column !== '_id' || typeof value !== 'string' || !OBJECT_ID_HEX.test(value)) return value;
    const { ObjectId } = this.load();
    return { $in: [new ObjectId(value), value] };
  }

  // Standalone Mongo rejects transactions; see the class comment.
  async beginTransaction(_connection: any): Promise<void> {}
  async commitTransaction(_connection: any): Promise<void> {}
  async rollbackTransaction(_connection: any): Promise<void> {}

  async setCurrentSchema(connection: any, schema: string): Promise<void> {
    if (schema?.trim()) connection.database = schema.trim();
  }

  async closeAll(): Promise<void> {
    const entries = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(entries.map((e) => e.client.close().catch(() => undefined)));
  }
}

export const mongoDbAdapter = new MongoDbAdapter();
