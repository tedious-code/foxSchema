/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/db/src/mysql.ts).
 */
import * as z from 'zod';
import { resolveDialect } from '@foxschema/sql';
import type { PipeContext, RecordBatch, SinkPipe } from '../../registry/index.js';
import { definePipeMetadata, type PipeMetadata } from '../../sdk/index.js';
// Shared with the PostgreSQL sink. The 65,535 budget is PostgreSQL's bind
// limit; MySQL's ceiling is `max_allowed_packet` rather than a placeholder
// count, so chunking at the stricter of the two is safe for both.
import { chunkForParameterLimit } from './postgres.js';
import { quote, type MysqlClient, type MysqlClientFactory } from './mysql-source.js';

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const configSchema = z.object({
  /** MySQL namespaces by database, not by schema-within-database. */
  database: identifier.optional(),
  table: identifier,
  columns: z
    .record(z.string(), z.string().min(1))
    .refine(
      (columns) => Object.keys(columns).length > 0,
      'at least one MySQL column is required',
    ),
});

/**
 * Bulk MySQL sink, and the destination half of a cross-engine migration.
 *
 * Replay safety works the same way as the PostgreSQL sink: a batch claims its
 * id in `_foxflow_committed_batches` inside the same transaction as its rows,
 * so an at-least-once redelivery finds the claim taken and writes nothing. The
 * mechanism differs because MySQL has no `ON CONFLICT DO NOTHING … RETURNING`
 * — `INSERT IGNORE` plus `affectedRows` says the same thing.
 */
export class MysqlSinkPipe implements SinkPipe {
  readonly type = 'sink.mysql';
  readonly role = 'sink';

  constructor(
    private readonly createClient: MysqlClientFactory = defaultClient,
  ) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'MySQL: load table',
      category: 'Output/Database',
      family: 'database',
      // SQL query / SQL write cover every dialect and are what the palette
      // offers first; this engine-specific pipe (resumable keyset paging or
      // exactly-once batch claims) stays one toggle away.
      palette: 'advanced',
      tags: ['sql', 'mysql'],
      version: '0.1.0',
      role: 'sink',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    configSchema.parse(config);
  }

  async write(batch: RecordBatch, context: PipeContext): Promise<void> {
    const config = configSchema.parse(context.pipe.config);
    const client = await this.createClient(context);
    const table = config.database
      ? `${quote(config.database)}.${quote(config.table)}`
      : quote(config.table);
    const commitTable = config.database
      ? `${quote(config.database)}.${quote('_foxflow_committed_batches')}`
      : quote('_foxflow_committed_batches');
    const renderedColumns = await renderColumns(config.columns);

    await client.connect();
    try {
      // The database is *not* created. A PostgreSQL schema is a namespace
      // inside a database the operator already granted; a MySQL database is
      // the whole container, and creating one needs a privilege no
      // least-privilege migration user should hold. Requiring it to exist
      // keeps the sink inside the grant it was given — and the failure is
      // reported here, in terms of the config, rather than as MySQL's
      // "Access denied … to database" from three statements later.
      if (config.database) {
        const [found] = await client.query(
          'SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?',
          [config.database],
        );
        if (found.length === 0) {
          throw new Error(
            `MySQL database ${config.database} does not exist. Create it and grant the ` +
              'migration user access; the sink deliberately does not create databases.',
          );
        }
      }
      // MySQL commits DDL implicitly, so schema setup happens before the
      // transaction rather than inside it — wrapping it would silently end the
      // transaction and leave the row insert unprotected.
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${commitTable} (
           batch_id VARCHAR(255) NOT NULL,
           target_table VARCHAR(255) NOT NULL,
           committed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
           PRIMARY KEY (batch_id, target_table)
         )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${table} (${renderedColumns
          .map(([name, type]) => `${quote(name)} ${type}`)
          .join(', ')})`,
      );
      const existing = await columnNames(client, config, table);
      for (const [name, type] of renderedColumns) {
        if (existing.has(name.toLowerCase())) continue;
        await client.query(
          `ALTER TABLE ${table} ADD COLUMN ${quote(name)} ${type}`,
        );
      }

      await client.query('START TRANSACTION');
      try {
        // INSERT IGNORE is the claim: a second delivery of the same batch
        // affects no rows and takes the early return below.
        // Source batch ids repeat across scheduled runs, so include the run:
        // retries still deduplicate while a later run writes its new rows.
        const claimId = JSON.stringify([context.workflowRunId, batch.id]);
        const [claim] = await client.query(
          `INSERT IGNORE INTO ${commitTable}(batch_id, target_table) VALUES (?, ?)`,
          [claimId, `${config.database ?? ''}.${config.table}`],
        );
        const claimed = (claim as unknown as { affectedRows?: number })
          .affectedRows;

        if ((claimed ?? 0) > 0 && batch.records.length > 0) {
          const names = Object.keys(config.columns);
          for (const rows of chunkForParameterLimit(batch.records, names.length)) {
            const values = rows.flatMap((record: Record<string, unknown>) =>
              names.map((name) => record[name] ?? null),
            );
            const tuples = rows.map(
              () => `(${names.map(() => '?').join(', ')})`,
            );
            await client.query(
              `INSERT INTO ${table} (${names.map(quote).join(', ')})
               VALUES ${tuples.join(', ')}`,
              values,
            );
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      await client.end();
    }
  }
}

/** Existing columns, so `ADD COLUMN` is only issued for genuinely new ones. */
async function columnNames(
  client: MysqlClient,
  config: { database?: string; table: string },
  table: string,
): Promise<Set<string>> {
  const [rows] = await client.query(`SHOW COLUMNS FROM ${table}`);
  return new Set(
    rows.map((row) => String(row.Field ?? row.field ?? '').toLowerCase()),
  );
}

/**
 * Column types are allowlisted, on both the dialect path and the fallback, for
 * the same reason as PostgreSQL: a type cannot be a bound parameter and cannot
 * be quoted as an identifier, so it reaches DDL as text.
 */
const MYSQL_TYPES =
  /^(tinyint|smallint|mediumint|int|integer|bigint|serial|bit|bool|boolean|float|double|real|decimal|numeric|date|datetime|timestamp|time|year|char|varchar|tinytext|text|mediumtext|longtext|tinyblob|blob|mediumblob|longblob|json|uuid)$/;

const MYSQL_SIZED_TYPES =
  // eslint-disable-next-line security/detect-unsafe-regex -- false positive: anchored alternatives of fixed type names with bounded {m,n} digit counts
  /^(char|varchar|binary|varbinary)\([1-9][0-9]{0,4}\)$|^(decimal|numeric|float|double)\([1-9][0-9]{0,2}(,[0-9]{1,3})?\)$|^(datetime|timestamp|time)\([0-6]\)$|^(tinyint|smallint|mediumint|int|integer|bigint)\([1-9][0-9]?\)$/;

export function fallbackMysqlType(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const withoutUnsigned = normalized.replace(/ unsigned$/, '');
  if (MYSQL_TYPES.test(withoutUnsigned) || MYSQL_SIZED_TYPES.test(withoutUnsigned)) {
    return normalized;
  }
  throw new Error(
    `unsupported MySQL column type: ${raw}. Types are allowlisted because the ` +
      'value is interpolated into DDL; add it to MYSQL_TYPES in ' +
      'packages/pipes/db/src/mysql.ts if it is safe and spelled correctly.',
  );
}

async function renderColumns(
  columns: Record<string, string>,
): Promise<Array<[string, string]>> {
  const dialect = resolveDialect('mysql');

  return Object.entries(columns).map(([name, raw]) => {
    const checked = fallbackMysqlType(raw);
    if (!dialect) return [name, checked];
    const rendered = dialect.renderType(dialect.parseType(raw));
    const sql = fallbackMysqlType(
      typeof rendered === 'string' ? rendered : rendered.sql,
    );
    // The dialect formats; it does not vouch for safety, so its output is
    // checked too — and it does not get to drop detail. `datetime(6)` came
    // back as `datetime`, and MySQL then truncated every value to whole
    // seconds. A declared precision silently discarded is the same class of
    // loss as parsing a timestamp into a `Date`; when the author asked for a
    // precision and the rendering lost it, the author wins.
    return [name, droppedPrecision(checked, sql) ? checked : sql];
  });
}

/** True when the author's type carried a `(…)` precision and the rendering did not. */
function droppedPrecision(raw: string, rendered: string): boolean {
  return raw.includes('(') && !rendered.includes('(');
}

async function defaultClient(context: PipeContext): Promise<MysqlClient> {
  if (!context.pipe.credentialId || !context.credentials) {
    throw new Error('MySQL sink requires a stored credential');
  }
  const secret = await context.credentials.revealSecret(
    context.pipe.credentialId,
  );
  if (!secret) throw new Error('MySQL credential not found');
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    ...(secret as Record<string, unknown>),
    dateStrings: true,
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  return {
    connect: async () => undefined,
    end: () => connection.end(),
    query: (sql, values) =>
      connection.query(sql, values) as Promise<
        [Record<string, unknown>[], unknown]
      >,
  };
}
