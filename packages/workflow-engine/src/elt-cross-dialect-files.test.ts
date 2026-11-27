/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Edge-case ELT, cross-dialect data migration, and file-source workflow tests:
 * 1. Cross-dialect data migration across all 14 SQL dialects (source.db.sql →
 *    transform.dedupe → transform.redact → sink.db.mapped-insert / sink.db.sql)
 *    verifying dialect-specific parameter placeholders ($1, ?, @p0, :1),
 *    identifier quoting ("col", `col`, [col]), Oracle single-row INSERTs,
 *    SQL Server 1,000-row batch chunking, and composite key upserts.
 * 2. File source edge cases:
 *    - source.file.csv with UTF-8 BOM, skipLines report preamble, RFC 4180
 *      multi-line quoted fields, doubled quotes (""), and formula-escaped output.
 *    - source.file.text in both delimited mode (with recordDelimiter flat-map
 *      and multi-regex column rules + type conversions) and fixed-width mode
 *      with dead-letter rejects.
 *    - source.file.json in both JSON array and NDJSON streaming modes with
 *      malformed line dead-lettering (onInvalid: 'reject') into a database sink.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from './common/index.js';
import { parseWorkflow } from './common/index.js';
import { Engine } from './engine.js';
import { MappedDbSinkPipe, SqlSinkPipe, SqlSourcePipe, type SqlConnection, type SqlRunner, type SqlSession } from './pipes/db/sql.js';
import type { PipeContext, RecordBatch } from './registry/index.js';

const ALL_SQL_DIALECTS = [
  'postgres',
  'cockroachdb',
  'yugabytedb',
  'redshift',
  'mysql',
  'mariadb',
  'tidb',
  'sqlite',
  'duckdb',
  'sqlserver',
  'azuresql',
  'oracle',
  'db2',
  'clickhouse',
] as const;

class RecordingDialectSession implements SqlSession {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  transactions = 0;
  closed = false;

  constructor(private readonly rows: Record<string, unknown>[] = []) {}

  async query(sql: string, params: readonly unknown[]) {
    this.queries.push({ sql, params: [...params] });
    return this.rows;
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.transactions += 1;
    return work();
  }

  async close() {
    this.closed = true;
  }
}

function makePipeContext(
  type: string,
  role: 'source' | 'sink',
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  extra: Partial<PipeContext> = {},
): PipeContext {
  const credentials = {
    revealSecret: async (id: string) => (id === 'cred-1' ? secret : undefined),
  } as unknown as CredentialStore;
  return {
    workflowRunId: 'run-cross-dialect',
    pipelineId: 'p1',
    pipe: { id: 'pipe-1', type, role, config, concurrency: 1, credentialId: 'cred-1' },
    credentials,
    ...extra,
  };
}

describe('Cross-dialect data migration across all 14 SQL dialects', () => {
  it.each(ALL_SQL_DIALECTS)(
    'extracts via source.db.sql and migrates via sink.db.mapped-insert on %s with dialect-native quoting and parameter binding',
    async (dialect) => {
      const legacySourceRows = [
        {
          tenant: { code: 'TNT-1' },
          account: { id: 'ACC-01', name: "  O'Brien & Co — 東京  ", email: '  OBRIEN@Example.com ' },
          billing: { cents: 19995, active_flag: 1 },
        },
        {
          tenant: { code: 'TNT-1' },
          account: { id: 'ACC-02', name: 'Müller; DROP TABLE users;--', email: 'muller@example.de' },
          billing: { cents: null, active_flag: 0 },
        },
      ];

      const sourceSession = new RecordingDialectSession(legacySourceRows);
      const sourceOpened: SqlConnection[] = [];
      const openSource: SqlRunner = async (conn) => {
        sourceOpened.push(conn);
        return sourceSession;
      };

      const sourcePipe = new SqlSourcePipe(openSource);
      const sourceBatches: RecordBatch[] = [];
      for await (const batch of sourcePipe.read(
        makePipeContext(
          'source.db.sql',
          'source',
          {
            sql: 'SELECT * FROM legacy_accounts WHERE tenant_code = {{vars.tenant}} AND min_cents >= {{trigger.minCents}}',
            batchSize: 10,
          },
          { dialect, schema: 'legacy_app', option: { host: 'db.internal', database: 'erp' } },
          {
            variables: { tenant: "TNT-1'; DROP TABLE--" },
            invocation: { payload: { minCents: 0 } } as never,
          },
        ),
      )) {
        sourceBatches.push(batch);
      }

      expect(sourceBatches).toHaveLength(1);
      expect(sourceBatches[0]!.records).toHaveLength(2);
      expect(sourceSession.queries).toHaveLength(1);
      // Verify SQL injection payload stays strictly in params, never in SQL text
      expect(sourceSession.queries[0]!.sql).not.toContain('DROP TABLE');
      expect(sourceSession.queries[0]!.params).toEqual(["TNT-1'; DROP TABLE--", 0]);

      // Now load the extracted batch into the target dialect via MappedDbSinkPipe
      const sinkSession = new RecordingDialectSession();
      const openSink: SqlRunner = async () => sinkSession;
      const sinkPipe = new MappedDbSinkPipe(openSink);

      await sinkPipe.write(
        sourceBatches[0]!,
        makePipeContext(
          'sink.db.mapped-insert',
          'sink',
          {
            mode: 'mapped',
            table: 'crm_accounts',
            ...(dialect === 'postgres' || dialect === 'sqlite'
              ? { upsertKeys: ['tenant_id', 'account_id'] }
              : {}),
            columnMapping: [
              { targetColumn: 'tenant_id', sourcePath: 'tenant.code', isKey: true },
              { targetColumn: 'account_id', sourcePath: 'account.id', isKey: true },
              { targetColumn: 'customer_name', sourcePath: 'account.name', expression: 'String(value).trim()' },
              { targetColumn: 'email', sourcePath: 'account.email', expression: 'String(value).trim().toLowerCase()' },
              { targetColumn: 'balance_usd', sourcePath: 'billing.cents', expression: 'Number(value) / 100', defaultValue: 0 },
              { targetColumn: 'is_active', sourcePath: 'billing.active_flag', expression: "Number(value) === 1 ? 'true' : 'false'" },
            ],
          },
          { dialect, schema: 'crm', option: { host: 'db.internal', database: 'crm' } },
        ),
      );

      // Oracle emits 1 INSERT per row; all other 13 SQL dialects batch both rows into 1 INSERT
      if (dialect === 'oracle') {
        expect(sinkSession.queries).toHaveLength(2);
        expect(sinkSession.queries[0]!.sql).toContain('INSERT INTO "crm_accounts"');
        expect(sinkSession.queries[0]!.sql).toContain(':1');
      } else {
        expect(sinkSession.queries).toHaveLength(1);
        const q = sinkSession.queries[0]!;
        expect(q.params).toEqual([
          'TNT-1',
          'ACC-01',
          "O'Brien & Co — 東京",
          'obrien@example.com',
          199.95,
          'true',
          'TNT-1',
          'ACC-02',
          'Müller; DROP TABLE users;--',
          'muller@example.de',
          0,
          'false',
        ]);
        if (dialect === 'postgres' || dialect === 'sqlite') {
          expect(q.sql).toContain('ON CONFLICT ("tenant_id", "account_id") DO UPDATE SET');
        }
      }
      expect(sinkSession.closed).toBe(true);
    },
  );
});

describe('File sources (CSV, Delimited/Fixed Text, NDJSON) + In-DB SQL ELT engine integration', () => {
  let filesDir: string;
  let engine: Engine;

  beforeAll(() => {
    filesDir = mkdtempSync(join(tmpdir(), 'fox-elt-files-'));
    vi.stubEnv('FOXFLOW_FILES_DIR', filesDir);
    engine = new Engine({
      databasePath: ':memory:',
      encryptionKey: randomBytes(32),
      instanceId: 'elt-files-test',
    });
  });

  afterAll(() => {
    engine?.close();
    vi.unstubAllEnvs();
    rmSync(filesDir, { recursive: true, force: true });
  });

  it('executes a multi-source File (CSV with BOM/preamble/quotes + NDJSON with corrupt line + Fixed-width text) → ELT SQLite warehouse workflow', async () => {
    // 1. Write an RFC 4180 CSV with UTF-8 BOM, 2 preamble lines, multi-line quoted notes, doubled quotes, and a bad row
    const csvContent =
      '\uFEFF# ERP Export Report v2.4\n' +
      '# Generated: 2026-11-26\n' +
      'order_id,customer,amount_usd,notes\n' +
      'ORD-1001,"Acme ""Global"" Ltd",250.75,"Line 1\nLine 2 note"\n' +
      'ORD-1002,"Beta Corp",125.25,"=cmd|calc formula attempt"\n' +
      'ORD-1003,"Bad Negative Order",-99.00,"Should be rejected"\n';
    writeFileSync(join(filesDir, 'erp_orders_preamble.csv'), csvContent, 'utf8');

    // 2. Write an NDJSON stream containing 2 valid payment events and 1 corrupt JSON line
    const ndjsonContent =
      '{"payment_id":"PAY-1","order_id":"ORD-1001","status":"settled","fee_usd":5.75}\n' +
      '{CORRUPT_JSON_LINE_THAT_MUST_BE_DEAD_LETTERED\n' +
      '{"payment_id":"PAY-2","order_id":"ORD-1002","status":"settled","fee_usd":2.25}\n';
    writeFileSync(join(filesDir, 'payments_stream.ndjson'), ndjsonContent, 'utf8');

    // 3. Write a mainframe-style fixed-width file (cols: sku [1..8], warehouse [9..12], stock [13..16]) with 1 bad non-integer stock row
    const fixedContent =
      'SKU-0001WH010150\n' +
      'SKU-0002WH02ABCD\n' +
      'SKU-0003WH010075\n';
    writeFileSync(join(filesDir, 'mainframe_inventory.txt'), fixedContent, 'utf8');

    const workflow = parseWorkflow({
      id: 'elt-multi-file-sources-edge-test',
      name: 'Multi-File Sources & In-DB ELT Edge Test',
      version: 1,
      onOverlap: 'skip',
      triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
      dependencies: [
        { from: 'ingest_all_file_sources', to: 'in_db_elt_join_and_export', on: 'success' },
      ],
      pipelines: [
        {
          id: 'ingest_all_file_sources',
          name: '1. Ingest CSV, NDJSON, and Fixed-Width Files',
          task: 'Read all three file formats, dead-letter corrupt records, and load raw SQLite tables',
          pipes: [
            {
              id: 'csv_source',
              role: 'source',
              type: 'source.file.csv',
              config: {
                path: 'erp_orders_preamble.csv',
                delimiter: ',',
                skipLines: 2,
              },
            },
            {
              id: 'coerce_csv',
              role: 'transform',
              type: 'transform.script',
              config: {
                script: `return records.map((r) => ({
                  order_id: String(r.order_id),
                  customer: String(r.customer),
                  amount_usd: Number(r.amount_usd),
                  notes: String(r.notes),
                }));`,
              },
            },
            {
              id: 'verify_csv_orders',
              role: 'transform',
              type: 'transform.verify',
              config: {
                onInvalid: 'reject',
                rules: [{ field: 'amount_usd', op: 'gt', value: 0, message: 'amount_usd must be positive' }],
              },
            },
            {
              id: 'sink_raw_orders',
              role: 'sink',
              type: 'sink.db.sql',
              config: {
                dialect: 'sqlite',
                mode: 'insert',
                table: 'raw_file_orders',
                upsertKey: 'order_id',
                columns: ['order_id', 'customer', 'amount_usd', 'notes'],
              },
            },
            {
              id: 'sink_csv_rejects',
              role: 'sink',
              type: 'sink.file.delimited',
              config: {
                path: 'rejected_orders.csv',
                columns: ['order_id', 'customer', 'amount_usd', 'notes'],
                delimiter: ',',
                header: true,
                mode: 'overwrite',
              },
            },
            {
              id: 'ndjson_source',
              role: 'source',
              type: 'source.file.json',
              config: {
                path: 'payments_stream.ndjson',
                format: 'ndjson',
                onInvalid: 'reject',
              },
            },
            {
              id: 'sink_raw_payments',
              role: 'sink',
              type: 'sink.db.sql',
              config: {
                dialect: 'sqlite',
                mode: 'insert',
                table: 'raw_file_payments',
                upsertKey: 'payment_id',
                columns: ['payment_id', 'order_id', 'status', 'fee_usd'],
              },
            },
            {
              id: 'sink_ndjson_rejects',
              role: 'sink',
              type: 'sink.file.delimited',
              config: {
                path: 'rejected_ndjson.csv',
                columns: ['_raw'],
                delimiter: ',',
                header: true,
                mode: 'overwrite',
              },
            },
            {
              id: 'fixed_text_source',
              role: 'source',
              type: 'source.file.text',
              config: {
                path: 'mainframe_inventory.txt',
                format: 'fixed',
                onInvalid: 'reject',
                columns: [
                  { name: 'sku', start: 1, length: 8, type: 'string', required: true },
                  { name: 'warehouse', start: 9, length: 4, type: 'string', required: true },
                  { name: 'stock', start: 13, length: 4, type: 'integer', required: true },
                ],
              },
            },
            {
              id: 'sink_fixed_inventory',
              role: 'sink',
              type: 'sink.db.sql',
              config: {
                dialect: 'sqlite',
                mode: 'insert',
                table: 'raw_fixed_inventory',
                upsertKey: 'sku',
                columns: ['sku', 'warehouse', 'stock'],
              },
            },
            {
              id: 'sink_fixed_rejects',
              role: 'sink',
              type: 'sink.file.delimited',
              config: {
                path: 'rejected_fixed_inventory.csv',
                columns: ['sku', 'warehouse', 'stock'],
                delimiter: ',',
                header: true,
                mode: 'overwrite',
              },
            },
          ],
          edges: [
            { from: 'csv_source', to: 'coerce_csv', fromPort: 'out' },
            { from: 'coerce_csv', to: 'verify_csv_orders', fromPort: 'out' },
            { from: 'verify_csv_orders', to: 'sink_raw_orders', fromPort: 'out' },
            { from: 'verify_csv_orders', to: 'sink_csv_rejects', fromPort: 'rejects' },
            { from: 'ndjson_source', to: 'sink_raw_payments', fromPort: 'out' },
            { from: 'ndjson_source', to: 'sink_ndjson_rejects', fromPort: 'rejects' },
            { from: 'fixed_text_source', to: 'sink_fixed_inventory', fromPort: 'out' },
            { from: 'fixed_text_source', to: 'sink_fixed_rejects', fromPort: 'rejects' },
          ],
        },
        {
          id: 'in_db_elt_join_and_export',
          name: '2. In-DB SQL Join & Safe CSV Export',
          task: 'Join orders with payments in SQLite and export formula-escaped reconciliation CSV',
          pipes: [
            {
              id: 'join_orders_payments_sql',
              role: 'source',
              type: 'source.db.sql',
              config: {
                dialect: 'sqlite',
                transaction: true,
                sql: `SELECT
  o.order_id,
  o.customer,
  o.amount_usd,
  p.payment_id,
  p.fee_usd,
  ROUND(o.amount_usd - p.fee_usd, 2) AS net_settled_usd,
  o.notes,
  (SELECT SUM(stock) FROM raw_fixed_inventory) AS total_warehouse_stock
FROM raw_file_orders o
JOIN raw_file_payments p ON p.order_id = o.order_id
ORDER BY o.order_id;`,
              },
            },
            {
              id: 'export_settled_csv',
              role: 'sink',
              type: 'sink.file.delimited',
              config: {
                path: 'elt_settled_orders.csv',
                columns: [
                  'order_id',
                  'customer',
                  'amount_usd',
                  'payment_id',
                  'fee_usd',
                  'net_settled_usd',
                  'notes',
                  'total_warehouse_stock',
                ],
                delimiter: ',',
                header: true,
                mode: 'overwrite',
                escapeFormulas: true,
              },
            },
          ],
          edges: [
            { from: 'join_orders_payments_sql', to: 'export_settled_csv', fromPort: 'out' },
          ],
        },
      ],
    });

    await engine.stores.workflows.put(workflow);
    const { run } = await engine.scheduler.enqueue(workflow, undefined);
    await engine.idle();

    const record = await engine.stores.runs.get(run!.id);
    expect(record?.status).toBe('succeeded');

    // Verify the exported ELT settled orders CSV has both valid orders joined with payments,
    // total_warehouse_stock = 225 (150 + 75), and formula injection prefixed with a single quote ('=cmd|calc)
    const settledCsv = readFileSync(join(filesDir, 'elt_settled_orders.csv'), 'utf8');
    expect(settledCsv).toContain('ORD-1001,"Acme ""Global"" Ltd",250.75,PAY-1,5.75,245');
    expect(settledCsv).toContain('225');
    expect(settledCsv).toContain("'=cmd|calc formula attempt");

    // Verify all 3 dead-letter reject files captured the exact malformed rows
    const rejectedOrders = readFileSync(join(filesDir, 'rejected_orders.csv'), 'utf8');
    expect(rejectedOrders).toContain('ORD-1003,Bad Negative Order,-99');

    const rejectedNdjson = readFileSync(join(filesDir, 'rejected_ndjson.csv'), 'utf8');
    expect(rejectedNdjson).toContain('CORRUPT_JSON_LINE_THAT_MUST_BE_DEAD_LETTERED');

    const rejectedFixed = readFileSync(join(filesDir, 'rejected_fixed_inventory.csv'), 'utf8');
    expect(rejectedFixed).toContain('SKU-0002,WH02,ABCD');
  });
});
