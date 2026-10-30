import { type ConnectionOptions, type DriverAdapter } from '@foxschema/sql';
import { BoundedPoolCache, credentialedCacheKey, disposePoolEndOrClose } from '../../cores/pool-cache.js';
import { queryTimeoutMs } from '../../cores/timeouts.js';
import { requireDriver } from '../../cores/driver-loader.js';

/**
 * Statements that must not go through `client.query()`.
 *
 * `query()` appends `FORMAT JSONEachRow` to whatever it is given, because it
 * exists to read a result set back. ClickHouse's parser tolerates that trailing
 * clause on table DDL, which is why migrations work — but the access-management
 * grammar (CREATE/DROP/ALTER USER|ROLE, GRANT, REVOKE) has a fixed tail and
 * rejects it outright, so every Database Access statement came back as
 * "Syntax error … FORMAT". `command()` sends the statement as written.
 *
 * This is a denylist rather than an allowlist of row-returning statements on
 * purpose: anything unrecognised keeps today's `query()` path, so a statement
 * that currently returns rows cannot start silently returning none.
 */
const NO_RESULT_SET =
  /^(CREATE|DROP|ALTER|GRANT|REVOKE|RENAME|ATTACH|DETACH|TRUNCATE|INSERT|SET|USE|OPTIMIZE|KILL|SYSTEM|DELETE|UPDATE)\b/i;

/** Leading comments and whitespace hide the verb — the editor sends both. */
function leadingVerbOf(sql: string): string {
  let rest = sql.trim();
   
  while (true) {
    if (rest.startsWith('--')) {
      const nl = rest.indexOf('\n');
      if (nl < 0) return '';
      rest = rest.slice(nl + 1).trim();
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      if (end < 0) return '';
      rest = rest.slice(end + 2).trim();
      continue;
    }
    return rest;
  }
}

// ClickHouse uses HTTP — the "connection" is a stateless client instance.
// Transactions are experimental in ClickHouse; begin/commit/rollback are no-ops here.
class ClickHouseAdapter implements DriverAdapter {
  readonly dialect = 'clickhouse';
  readonly packageName = '@clickhouse/client';

  private clients = new BoundedPoolCache<any>(disposePoolEndOrClose);
  private mod: any;

  private load(): any {
    if (this.mod) return this.mod;
    this.mod = requireDriver(this.packageName, this.dialect);
    return this.mod;
  }

  async acquire(connectionString: string, options: ConnectionOptions, _pooled: boolean): Promise<any> {
    // ClickHouse connection strings are only http(s)://host:port — username,
    // password, and database are separate createClient options. Keying by URL
    // alone reused the first client for every database/user on that host.
    const username = options.username || 'default';
    const password = options.password || '';
    const database = options.database || options.schema || 'default';
    const clientKey = credentialedCacheKey({
      connectionString,
      username,
      password,
      database,
    });
    return this.clients.getOrCreate(clientKey, () => {
      const { createClient } = this.load();
      return createClient({
        url: connectionString,
        username,
        password,
        database,
        request_timeout: queryTimeoutMs(options, 30_000),
        compression: { response: true, request: false },
      });
    });
  }

  async release(_client: any): Promise<void> {
    // HTTP is stateless — nothing to release.
  }

  async query<T = Record<string, unknown>>(client: any, sql: string, params: readonly unknown[]): Promise<T[]> {
    // Replace $N positional placeholders with quoted values (catalog queries only; no user data).
    let finalSql = sql;
    if (params.length > 0) {
      finalSql = sql.replace(/\$(\d+)/g, (_, idx) => {
        const val = params[Number(idx) - 1];
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number') return String(val);
        return `'${String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      });
    }
    if (NO_RESULT_SET.test(leadingVerbOf(finalSql))) {
      await client.command({ query: finalSql });
      return [] as T[];
    }
    const result = await client.query({ query: finalSql, format: 'JSONEachRow' });
    return result.json() as Promise<T[]>;
  }

  async beginTransaction(_client: any): Promise<void> {
    // ClickHouse transactions are experimental — migrations run as individual DDL statements.
  }

  async commitTransaction(_client: any): Promise<void> {}

  async rollbackTransaction(_client: any): Promise<void> {}

  async setCurrentSchema(_client: any, _schema: string): Promise<void> {
    // ClickHouse database is set at client-creation time; DDL must be schema-qualified.
  }

  async closeAll(): Promise<void> {
    await this.clients.clear();
  }
}

export const clickHouseAdapter = new ClickHouseAdapter();
