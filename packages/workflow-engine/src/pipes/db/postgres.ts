/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/db/src/postgres.ts).
 */
import type { ClientConfig } from 'pg';
import * as z from 'zod';
import { quoteSqlIdentifier, resolveDialect } from '@foxschema/sql';
import type {
  PipeContext,
  RecordBatch,
  SinkPipe,
} from '../../registry/index.js';
import { definePipeMetadata, type PipeMetadata } from '../../sdk/index.js';

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const configSchema = z.object({
  schema: identifier.default('public'),
  table: identifier,
  columns: z.record(z.string(), z.string().min(1)).refine(
    (columns) => Object.keys(columns).length > 0,
    'at least one PostgreSQL column is required',
  ),
});

export interface PostgresClient {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>;
}

export type PostgresClientFactory = (
  context: PipeContext,
) => Promise<PostgresClient>;

export class PostgresSinkPipe implements SinkPipe {
  readonly type = 'sink.postgres';
  readonly role = 'sink';

  constructor(
    private readonly createClient: PostgresClientFactory = defaultClient,
  ) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'PostgreSQL: load table',
      category: 'Output/Database',
      family: 'database',
      // SQL query / SQL write cover every dialect and are what the palette
      // offers first; this engine-specific pipe (resumable keyset paging or
      // exactly-once batch claims) stays one toggle away.
      palette: 'advanced',
      tags: ['sql', 'postgres'],
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
    const schema = quote(config.schema);
    const table = `${schema}.${quote(config.table)}`;
    const commitTable = `${schema}.${quote('_foxflow_committed_batches')}`;
    const renderedColumns = await renderColumns(config.columns);
    await client.connect();
    try {
      await client.query('BEGIN');
      // IF NOT EXISTS DDL is not concurrency-safe in Postgres (two parallel
      // batches both pass the existence check, one dies on the pg_namespace /
      // pg_class unique index). Serialize all DDL for this schema with a
      // transaction-scoped advisory lock; it releases on COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `foxflow:${config.schema}`,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${commitTable} (
          batch_id text NOT NULL,
          target_table text NOT NULL,
          committed_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (batch_id, target_table)
        )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${table} (${renderedColumns
          .map(([name, type]) => `${quote(name)} ${type}`)
          .join(', ')})`,
      );
      for (const [name, type] of renderedColumns) {
        await client.query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quote(name)} ${type}`,
        );
      }
      // Source batch ids are stable across scheduled runs. Scope the claim to
      // this run so retries deduplicate without suppressing tomorrow's rows.
      const claimId = JSON.stringify([context.workflowRunId, batch.id]);
      const claim = await client.query(
        `INSERT INTO ${commitTable}(batch_id, target_table)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING batch_id`,
        [claimId, `${config.schema}.${config.table}`],
      );
      if ((claim.rowCount ?? 0) > 0 && batch.records.length > 0) {
        const names = Object.keys(config.columns);
        // All chunks ride the transaction opened above, so the batch is still
        // written all-or-nothing and the commit claim stays meaningful.
        for (const rows of chunkForParameterLimit(batch.records, names.length)) {
          const values = rows.flatMap((record) =>
            names.map((name) => record[name] ?? null),
          );
          const tuples = rows.map((_, rowIndex) => {
            const start = rowIndex * names.length;
            return `(${names.map((__, index) => `$${start + index + 1}`).join(', ')})`;
          });
          await client.query(
            `INSERT INTO ${table} (${names.map(quote).join(', ')})
             VALUES ${tuples.join(', ')}`,
            values,
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
}

async function defaultClient(
  context: PipeContext,
): Promise<PostgresClient> {
  if (!context.pipe.credentialId || !context.credentials) {
    throw new Error('PostgreSQL sink requires a stored credential');
  }
  const secret = await context.credentials.revealSecret(
    context.pipe.credentialId,
  );
  if (!secret) throw new Error('PostgreSQL credential not found');
  const { Client } = await import('pg');
  return new Client(secret as ClientConfig);
}

/**
 * A column type cannot be a bound parameter and cannot be quoted as an
 * identifier — it goes into DDL as text. So every type is checked against the
 * allowlist, on **both** paths.
 *
 * This used to guard only the fallback. When the dialect package was loadable the
 * dialect ran instead, and it returns anything it does not recognise verbatim:
 * `text; drop table users` came back unchanged and went straight into
 * `CREATE TABLE`. The allowlist was described as injection-safe while the path
 * that normally runs had no check at all.
 *
 * The dialect still renders — it normalises spellings the allowlist would
 * otherwise have to enumerate — but its output is re-checked, because a
 * dialect is a formatter, not a security boundary.
 */
async function renderColumns(
  columns: Record<string, string>,
): Promise<Array<[string, string]>> {
  const dialect = resolveDialect('postgres');

  return Object.entries(columns).map(([name, raw]) => {
    // Check what the author wrote before handing it to anything else.
    const checked = fallbackPostgresType(raw);
    if (!dialect) return [name, checked];

    const rendered = dialect.renderType(dialect.parseType(raw));
    const sql = typeof rendered === 'string' ? rendered : rendered.sql;
    // And check what came back, so the rule holds even if the dialect changes.
    return [name, fallbackPostgresType(sql)];
  });
}

/**
 * Column types accepted when `@foxschema/sql` is not loadable.
 *
 * This is an allowlist because the value is interpolated into DDL, so anything
 * it admits has to be safe by construction rather than by escaping. It is
 * deliberately narrow — but narrow is not the same as arbitrary, and a type a
 * migration will obviously hit belongs in it. Unparameterised `numeric` was
 * missing while `numeric(12,2)` was allowed, which failed a migration of a
 * money column on the most ordinary spelling of it.
 *
 * Aliases are listed rather than normalised away: PostgreSQL accepts `int4`
 * and `float8` as readily as `integer` and `double precision`, and a table
 * being copied from another system is as likely to name them that way.
 */
const POSTGRES_TYPES =
  /^(smallint|integer|bigint|int2|int4|int8|serial|bigserial|text|boolean|bool|date|time|timetz|timestamp|timestamptz|interval|json|jsonb|uuid|bytea|real|float4|float8|double precision|numeric|decimal|money)$/;

/** Types carrying a length or precision, e.g. `varchar(64)`, `numeric(12,2)`. */
const POSTGRES_SIZED_TYPES =
  // eslint-disable-next-line security/detect-unsafe-regex -- false positive: anchored alternatives of fixed type names with bounded {m,n} digit counts
  /^(varchar|character varying|char|character|bpchar)\([1-9][0-9]{0,5}\)$|^(numeric|decimal)\([1-9][0-9]{0,2}(,[0-9]{1,3})?\)$|^(time|timetz|timestamp|timestamptz)\([0-6]\)$/;

function fallbackPostgresType(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (POSTGRES_TYPES.test(normalized) || POSTGRES_SIZED_TYPES.test(normalized)) {
    return normalized;
  }
  throw new Error(
    `unsupported PostgreSQL column type: ${raw}. Types are allowlisted because ` +
      'the value is interpolated into DDL; add it to POSTGRES_TYPES in ' +
      'packages/pipes/db/src/postgres.ts if it is safe and spelled correctly.',
  );
}

function quote(value: string): string {
  return quoteSqlIdentifier(value, 'postgres');
}

/**
 * Postgres carries a statement's bind parameters in a 16-bit count, so a
 * single query can take at most 65535 of them. A batched insert uses
 * `rows x columns`, and nothing stopped that product from going over: a wide
 * table at a healthy `batchSize` — 8,000 rows of 10 columns is 80,000 — failed
 * with `bind message has 14464 parameter formats but 0 parameters`, which is
 * the count wrapping (80000 mod 65536) and names neither the limit nor the
 * cause. On the "huge migration" path, of all places.
 *
 * Splitting by the parameter budget keeps every statement legal whatever the
 * caller sets `batchSize` to. The chunks share the caller's transaction, so the
 * batch is still written all-or-nothing.
 */
const MAX_BIND_PARAMETERS = 65_535;

export function chunkForParameterLimit<T>(
  rows: T[],
  columnsPerRow: number,
): T[][] {
  if (columnsPerRow <= 0) return rows.length > 0 ? [rows] : [];
  const perStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columnsPerRow));
  if (rows.length <= perStatement) return [rows];

  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += perStatement) {
    chunks.push(rows.slice(index, index + perStatement));
  }
  return chunks;
}
