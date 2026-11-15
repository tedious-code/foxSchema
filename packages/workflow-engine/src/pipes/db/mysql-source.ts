/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/db/src/mysql-source.ts).
 */
import * as z from 'zod';
import type {
  PipeContext,
  RecordBatch,
  SourcePipe,
} from '../../registry/index.js';
import {
  batchSizeField,
  definePipeMetadata,
  type PipeMetadata,
} from '../../sdk/index.js';
import { quoteSqlIdentifier } from '@foxschema/sql';

/**
 * MySQL identifiers are quoted with backticks, and a backtick inside one is
 * escaped by doubling. The pattern is still restrictive because these values
 * reach SQL as text: quoting makes an identifier safe, but it is not a reason
 * to accept arbitrary input.
 */
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);

const configSchema = z.object({
  /** MySQL has no schema-inside-database; `database` is the namespace. */
  database: identifier.optional(),
  table: identifier,
  /**
   * Keyset-pagination column: unique and monotonically ordered. The cursor is
   * the last key seen, so a resumed run continues from there instead of
   * paying for an OFFSET scan it has already done once.
   */
  keyColumn: identifier,
  /** Columns to select; empty → all. `keyColumn` is always included. */
  columns: z.array(identifier).default([]),
  /** Optional raw SQL condition, ANDed with the keyset predicate. */
  where: z.string().optional(),
  ...batchSizeField({ max: 10_000 }),
});

export interface MysqlClient {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query(
    sql: string,
    values?: unknown[],
  ): Promise<[Record<string, unknown>[], unknown]>;
}

export type MysqlClientFactory = (context: PipeContext) => Promise<MysqlClient>;

/**
 * Streaming MySQL source: keyset pagination over `keyColumn`, one page per
 * RecordBatch, cursor `{lastKey}` — resumable exactly like the PostgreSQL
 * source, and the other half of a cross-engine migration.
 */
export class MysqlSourcePipe implements SourcePipe {
  readonly type = 'source.db.mysql';
  readonly role = 'source';

  constructor(
    private readonly createClient: MysqlClientFactory = defaultClient,
  ) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'MySQL: stream table',
      category: 'Source/Database',
      family: 'database',
      // SQL query / SQL write cover every dialect and are what the palette
      // offers first; this engine-specific pipe (resumable keyset paging or
      // exactly-once batch claims) stays one toggle away.
      palette: 'advanced',
      tags: ['sql', 'mysql'],
      version: '0.1.0',
      role: 'source',
      inputs: [{ name: 'in', type: 'records' }],
      outputs: [{ name: 'out', type: 'records' }],
      configSchema,
    });
  }

  validateConfig(config: Record<string, unknown>): void {
    configSchema.parse(config);
  }

  async *read(context: PipeContext): AsyncIterable<RecordBatch> {
    const config = configSchema.parse(context.pipe.config);
    const key = config.keyColumn;
    const selected = config.columns.length
      ? [...new Set([...config.columns, key])]
      : undefined;
    const table = config.database
      ? `${quote(config.database)}.${quote(config.table)}`
      : quote(config.table);
    const client = await this.createClient(context);
    await client.connect();
    try {
      let lastKey: unknown = context.checkpoint?.cursor.lastKey;
      while (true) {
        const conditions: string[] = [];
        const values: unknown[] = [];
        if (lastKey !== undefined && lastKey !== null) {
          values.push(lastKey);
          conditions.push(`${quote(key)} > ?`);
        }
        if (config.where) conditions.push(`(${config.where})`);
        const [rows] = await client.query(
          `SELECT ${selected ? selected.map(quote).join(', ') : '*'}
           FROM ${table}
           ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
           ORDER BY ${quote(key)} ASC
           LIMIT ${config.batchSize}`,
          values,
        );
        if (rows.length === 0) return;
        const first = rows[0]![key];
        const last = rows.at(-1)![key];
        if (last === undefined || last === null) {
          throw new Error(
            `key column ${key} returned NULL — keyset pagination needs a non-null unique column`,
          );
        }
        yield {
          id: `${context.pipe.id}:0:${String(first)}-${String(last)}`,
          partitionId: '0',
          records: rows,
          cursor: { lastKey: last as never },
        };
        lastKey = last;
        if (rows.length < config.batchSize) return;
      }
    } finally {
      await client.end();
    }
  }
}

async function defaultClient(context: PipeContext): Promise<MysqlClient> {
  if (!context.pipe.credentialId || !context.credentials) {
    throw new Error('MySQL source requires a stored credential');
  }
  const secret = await context.credentials.revealSecret(
    context.pipe.credentialId,
  );
  if (!secret) throw new Error('MySQL credential not found');
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    ...(secret as Record<string, unknown>),
    // Keep the wire text for types a JS value cannot hold exactly. `DATETIME`
    // and `TIMESTAMP` become `Date` otherwise, which is milliseconds — MySQL
    // stores microseconds — and `DECIMAL` becomes a float, which is the wrong
    // representation for money. A migration that rounds is not a migration.
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

/** Backtick quoting; an embedded backtick is doubled. */
export function quote(value: string): string {
  return quoteSqlIdentifier(value, 'mysql');
}
