/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/db/src/postgres-source.ts).
 */
import type { ClientConfig } from 'pg';
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
import type { PostgresClient, PostgresClientFactory } from './postgres.js';
import { quoteSqlIdentifier } from '@foxschema/sql';

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const configSchema = z.object({
  schema: identifier.default('public'),
  table: identifier,
  /**
   * Keyset-pagination column: unique and monotonically ordered (a serial PK,
   * a created_at+id composite is NOT supported — single column only). The
   * cursor is the last key seen, so runs resume without OFFSET scans.
   */
  keyColumn: identifier,
  /** Columns to select; empty → all. `keyColumn` is always included. */
  columns: z.array(identifier).default([]),
  /** Optional raw SQL condition, ANDed with the keyset predicate. */
  where: z.string().optional(),
  ...batchSizeField({ max: 10_000 }),
});

/**
 * Streaming PostgreSQL source: keyset pagination over `keyColumn`, one page
 * per RecordBatch, cursor `{lastKey}` — resumable exactly like the file
 * sources. Same credential + client-factory seam as the sink.
 */
export class PostgresSourcePipe implements SourcePipe {
  readonly type = 'source.db.postgres';
  readonly role = 'source';

  constructor(
    private readonly createClient: PostgresClientFactory = defaultClient,
  ) {}

  metadata(): PipeMetadata {
    return definePipeMetadata({
      type: this.type,
      name: 'PostgreSQL: stream table',
      category: 'Source/Database',
      family: 'database',
      // SQL query / SQL write cover every dialect and are what the palette
      // offers first; this engine-specific pipe (resumable keyset paging or
      // exactly-once batch claims) stays one toggle away.
      palette: 'advanced',
      tags: ['sql', 'postgres'],
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
    const table = `${quote(config.schema)}.${quote(config.table)}`;
    const client = await this.createClient(context);
    await client.connect();
    try {
      let lastKey: unknown = context.checkpoint?.cursor.lastKey;
      while (true) {
        const conditions: string[] = [];
        const values: unknown[] = [];
        if (lastKey !== undefined && lastKey !== null) {
          values.push(lastKey);
          conditions.push(`${quote(key)} > $1`);
        }
        if (config.where) conditions.push(`(${config.where})`);
        const { rows } = await client.query(
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

async function defaultClient(context: PipeContext): Promise<PostgresClient> {
  if (!context.pipe.credentialId || !context.credentials) {
    throw new Error('PostgreSQL source requires a stored credential');
  }
  const secret = await context.credentials.revealSecret(
    context.pipe.credentialId,
  );
  if (!secret) throw new Error('PostgreSQL credential not found');
  const pg = await import('pg');
  preserveTemporalPrecision(pg.types);
  return new pg.Client(secret as ClientConfig);
}

/**
 * OIDs for the date/time types the driver turns into `Date`. `numeric` already
 * arrives as a string, for exactly this reason, so it needs nothing here.
 */
export const TEMPORAL_OIDS = [1082 /* date */, 1114 /* timestamp */, 1184 /* timestamptz */];

let temporalParsersInstalled = false;

/** Test seam: parsers install once per process, so let a test reset that. */
export function resetTemporalParsersForTest(): void {
  temporalParsersInstalled = false;
}

/**
 * Hand timestamps back as the text PostgreSQL sent.
 *
 * PostgreSQL keeps microseconds; a JavaScript `Date` holds milliseconds. The
 * driver parses `timestamptz` into a `Date` by default, so copying between two
 * PostgreSQL databases silently truncated every timestamp —
 * `00:13:43.509878` arrived as `00:13:43.509`. Over a million rows that is a
 * million quietly altered values, and because the row counts still match,
 * nothing looks wrong.
 *
 * The text round-trips exactly: the sink binds it as a parameter and
 * PostgreSQL parses it back at full precision. Fidelity is not a trade a
 * migration tool gets to make for convenience.
 */
export function preserveTemporalPrecision(types: {
  setTypeParser: (oid: number, parse: (value: string) => unknown) => void;
}): void {
  if (temporalParsersInstalled) return;
  for (const oid of TEMPORAL_OIDS) types.setTypeParser(oid, (value) => value);
  temporalParsersInstalled = true;
}

function quote(value: string): string {
  return quoteSqlIdentifier(value, 'postgres');
}
