/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { parseWorkflow } from '@foxschema/workflow-engine/definitions';
import {
  SAMPLE_API_ENRICH_MULTI_DB_WORKFLOW_ID,
  SAMPLE_CROSS_DB_ETL_SPLIT_WORKFLOW_ID,
  SAMPLE_DEDUPE_NULLS_QUARANTINE_ETL_WORKFLOW_ID,
  SAMPLE_DIRTY_ETL_RECORDS,
  SAMPLE_EMPTY_BATCH_AND_LOOP_EDGE_WORKFLOW_ID,
  SAMPLE_FILE_CSV_MULTI_PIPELINE_WORKFLOW_ID,
  SAMPLE_HELLO_PEOPLE,
  SAMPLE_HELLO_WORKFLOW_ID,
  SAMPLE_LINEAR_API_FAILFAST_DB_WORKFLOW_ID,
  SAMPLE_MAPPED_DB_COMPOSITE_UPSERT_WORKFLOW_ID,
  SAMPLE_DBA_SCHEMA_HEALTH_AUDIT_WORKFLOW_ID,
  SAMPLE_DBA_RETENTION_MAINTENANCE_WORKFLOW_ID,
  SAMPLE_DBA_QUARANTINE_RECONCILE_WORKFLOW_ID,
  SAMPLE_MULTI_API_FANOUT_WORKFLOW_ID,
  SAMPLE_MULTI_API_MERGE_TO_DB_WORKFLOW_ID,
  SAMPLE_MULTI_DB_ETL_CONSOLIDATE_WORKFLOW_ID,
  SAMPLE_ORDERS,
  SAMPLE_ORDERS_WORKFLOW_ID,
  SAMPLE_PARTIAL_FAILURE_RECOVERY_WORKFLOW_ID,
  SAMPLE_CANVAS_ID,
  SAMPLE_REGIONS_WORKFLOW_ID,
  WORKFLOW_SAMPLES,
  sampleForCanvas,
  sampleWorkflowIds,
  samplesAlreadyInstalled,
  saveSampleWorkflows,
} from './workflowSamples';

function sample(id: string) {
  const found = WORKFLOW_SAMPLES.find((entry) => entry.id === id);
  expect(found, id).toBeTruthy();
  return found!;
}

describe('workflow samples', () => {
  it('gives every SQL insert step an upsertKey, so a second Test run replaces rows instead of duplicating them', () => {
    const missing: string[] = [];
    for (const entry of WORKFLOW_SAMPLES) {
      for (const pipeline of entry.document.pipelines) {
        for (const pipe of pipeline.pipes) {
          if (pipe.type === 'sink.db.sql' && pipe.config.mode === 'insert' && !pipe.config.upsertKey) {
            missing.push(`${entry.id} / ${pipe.id}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('exposes stable ids and ★ Sample names', () => {
    const ids = new Set(WORKFLOW_SAMPLES.map((entry) => entry.id));
    expect(ids.size).toBe(WORKFLOW_SAMPLES.length);
    expect(WORKFLOW_SAMPLES.length).toBeGreaterThanOrEqual(3);
    expect(sampleWorkflowIds()).toEqual(WORKFLOW_SAMPLES.map((entry) => entry.id));
    for (const entry of WORKFLOW_SAMPLES) {
      expect(entry.id).toMatch(/^sample-/);
      expect(entry.name).toMatch(/★ Sample/);
      expect(entry.document.id).toBe(entry.id);
      expect(entry.document.name).toBe(entry.name);
    }
  });

  it('hello sample carries the same demo people as the SQL Editor samples', () => {
    expect(sample(SAMPLE_HELLO_WORKFLOW_ID).document.triggers[0]?.inputData).toEqual(
      SAMPLE_HELLO_PEOPLE.map((person) => ({ ...person })),
    );
  });

  it('orders sample branches paid vs other and dead-letters a bad amount', () => {
    const parsed = parseWorkflow(sample(SAMPLE_ORDERS_WORKFLOW_ID).document);
    const pipeline = parsed.pipelines[0]!;
    const types = Object.fromEntries(pipeline.pipes.map((pipe) => [pipe.id, pipe.type]));
    expect(types).toMatchObject({
      start: 'source.trigger.manual',
      check: 'transform.verify',
      quarantine: 'transform.script',
      route: 'transform.condition',
      paid: 'transform.script',
      other: 'transform.script',
      join: 'transform.merge',
    });
    expect(pipeline.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'check', to: 'quarantine', fromPort: 'rejects' }),
        expect.objectContaining({ from: 'route', to: 'paid', fromPort: 'true' }),
        expect.objectContaining({ from: 'route', to: 'other', fromPort: 'false' }),
      ]),
    );
    const amounts = SAMPLE_ORDERS.map((order) => order.amount);
    expect(amounts.some((amount) => amount < 0)).toBe(true);
    expect(amounts.some((amount) => amount > 0)).toBe(true);
  });

  it('regions sample waits on a second pipeline after split and loop', () => {
    const parsed = parseWorkflow(sample(SAMPLE_REGIONS_WORKFLOW_ID).document);
    expect(parsed.pipelines.map((pipeline) => pipeline.id)).toEqual(['ingest', 'summarise']);
    expect(parsed.dependencies).toEqual([
      expect.objectContaining({ from: 'ingest', to: 'summarise', on: 'success' }),
    ]);
    const ingestTypes = parsed.pipelines[0]!.pipes.map((pipe) => pipe.type);
    expect(ingestTypes).toEqual([
      'source.trigger.manual',
      'transform.split',
      'logic.loop',
      'transform.script',
      'transform.merge',
    ]);
  });

  it('cities to postgres sample has a manual trigger feeding fetch_city and writing to postgres', () => {
    const found = sample('sample-cities-postgres');
    const parsed = parseWorkflow(found.document);
    expect(parsed.triggers.map((t) => t.kind).sort()).toEqual(['manual']);
    const pipeline = parsed.pipelines[0]!;
    const types = Object.fromEntries(pipeline.pipes.map((pipe) => [pipe.id, pipe.type]));
    expect(types).toMatchObject({
      manual_trigger: 'source.trigger.manual',
      fetch_city: 'source.api.http',
      insert_postgres: 'sink.db.sql',
      query_postgres: 'source.db.sql',
    });
    expect(pipeline.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'manual_trigger', to: 'fetch_city' }),
        expect.objectContaining({ from: 'fetch_city', to: 'insert_postgres' }),
        expect.objectContaining({ from: 'insert_postgres', to: 'query_postgres' }),
      ]),
    );
  });

  it('each sample parses as a workflow the engine would accept', () => {
    expect(WORKFLOW_SAMPLES.length).toBeGreaterThanOrEqual(15);
    for (const entry of WORKFLOW_SAMPLES) {
      const parsed = parseWorkflow(entry.document);
      expect(parsed.id).toBe(entry.id);
      expect(parsed.pipelines.length).toBeGreaterThan(0);
      expect(parsed.pipelines[0]!.pipes.length).toBeGreaterThan(0);
    }
  });

  it('includes edge-case samples for partial API failure recovery, dirty-data quarantine ETL, and empty branch + failure/always stages', () => {
    const partial = sample(SAMPLE_PARTIAL_FAILURE_RECOVERY_WORKFLOW_ID);
    expect(partial.document.dependencies).toEqual([
      { from: 'partial_api_ingest', to: 'audit_always_stage', on: 'always' },
    ]);
    const partialHttp = partial.document.pipelines[0]!.pipes[0]!;
    expect(partialHttp.config).toMatchObject({
      executionMode: 'parallel',
      outputMode: 'merge',
      onError: 'skip',
    });

    const dirty = sample(SAMPLE_DEDUPE_NULLS_QUARANTINE_ETL_WORKFLOW_ID);
    expect(SAMPLE_DIRTY_ETL_RECORDS.filter((r) => r.id === 301)).toHaveLength(2);
    expect(SAMPLE_DIRTY_ETL_RECORDS.some((r) => r.email === null)).toBe(true);
    expect(SAMPLE_DIRTY_ETL_RECORDS.some((r) => String(r.name).includes("O'Brien"))).toBe(true);
    expect(dirty.document.pipelines[0]!.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'verify_clean_rows', fromPort: 'rejects', to: 'format_quarantine_rows' }),
      ]),
    );

    const emptyBranch = sample(SAMPLE_EMPTY_BATCH_AND_LOOP_EDGE_WORKFLOW_ID);
    expect(emptyBranch.document.pipelines).toHaveLength(3);
    expect(emptyBranch.document.dependencies).toEqual([
      { from: 'empty_branch_pipeline', to: 'fallback_on_failure', on: 'failure' },
      { from: 'empty_branch_pipeline', to: 'always_summary', on: 'always' },
    ]);
  });

  it('includes samples for multi-URL parallel merge, linear fail-fast API fetch, and multi-DB ETL warehouse consolidation', () => {
    const parallelMerge = sample(SAMPLE_MULTI_API_MERGE_TO_DB_WORKFLOW_ID);
    const parallelHttp = parallelMerge.document.pipelines[0]!.pipes[0]!;
    expect(parallelHttp.type).toBe('source.api.http.multi');
    expect(parallelHttp.config).toMatchObject({
      executionMode: 'parallel',
      outputMode: 'merge',
      onError: 'skip',
    });
    expect(parallelMerge.document.pipelines).toHaveLength(2);

    const linearFailFast = sample(SAMPLE_LINEAR_API_FAILFAST_DB_WORKFLOW_ID);
    const linearHttp = linearFailFast.document.pipelines[0]!.pipes[0]!;
    expect(linearHttp.type).toBe('source.api.http.multi');
    expect(linearHttp.config).toMatchObject({
      executionMode: 'linear',
      outputMode: 'merge',
      onError: 'fail',
    });

    const multiDbEtl = sample(SAMPLE_MULTI_DB_ETL_CONSOLIDATE_WORKFLOW_ID);
    expect(multiDbEtl.document.pipelines).toHaveLength(2);
    expect(multiDbEtl.document.dependencies).toEqual([
      { from: 'seed_regional_dbs', to: 'consolidate_to_warehouse', on: 'success' },
    ]);
    const consolidateStage = multiDbEtl.document.pipelines[1]!;
    const sourceDialects = new Set(
      consolidateStage.pipes
        .filter((pipe) => pipe.type === 'source.db.sql')
        .map((pipe) => pipe.config.dialect),
    );
    const sinkDialects = new Set(
      consolidateStage.pipes
        .filter((pipe) => pipe.type === 'sink.db.sql')
        .map((pipe) => pipe.config.dialect),
    );
    expect(sourceDialects).toEqual(new Set(['postgres', 'sqlite']));
    expect(sinkDialects).toEqual(new Set(['postgres', 'sqlite']));
    expect(consolidateStage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'verify_order_quality', fromPort: 'rejects', to: 'quarantine_bad_orders' }),
      ]),
    );
  });

  it('includes multi-pipeline samples covering API enrich, CSV handoff, multi-HTTP split/loop, verify, merge, and multi-DB sinks', () => {
    const byId = new Map(WORKFLOW_SAMPLES.map((sample) => [sample.id, sample]));

    const enrich = byId.get(SAMPLE_API_ENRICH_MULTI_DB_WORKFLOW_ID)!;
    expect(enrich).toBeDefined();
    expect(enrich.document.pipelines).toHaveLength(2);
    expect(enrich.document.dependencies).toEqual([
      { from: 'enrich_and_load', to: 'verify_multi_db', on: 'success' },
    ]);
    const enrichTypes = new Set(
      enrich.document.pipelines.flatMap((p) => p.pipes.map((pipe) => pipe.type)),
    );
    expect(enrichTypes).toEqual(
      new Set([
        'source.trigger.manual',
        'source.api.http',
        'transform.verify',
        'transform.script',
        'transform.http',
        'transform.map',
        'transform.condition',
        'transform.merge',
        'sink.db.sql',
        'source.db.sql',
        'sink.file.delimited',
      ]),
    );

    const fileMulti = byId.get(SAMPLE_FILE_CSV_MULTI_PIPELINE_WORKFLOW_ID)!;
    expect(fileMulti).toBeDefined();
    expect(fileMulti.document.pipelines).toHaveLength(3);
    expect(fileMulti.document.dependencies).toEqual([
      { from: 'ingest_to_csv', to: 'csv_to_multi_db', on: 'success' },
      { from: 'csv_to_multi_db', to: 'verify_db_sync', on: 'success' },
    ]);
    const fileTypes = new Set(
      fileMulti.document.pipelines.flatMap((p) => p.pipes.map((pipe) => pipe.type)),
    );
    expect(fileTypes).toEqual(
      new Set([
        'source.trigger.manual',
        'source.api.http',
        'transform.script',
        'sink.file.delimited',
        'source.file.csv',
        'transform.verify',
        'transform.map',
        'sink.db.sql',
        'source.db.sql',
      ]),
    );

    const fanout = byId.get(SAMPLE_MULTI_API_FANOUT_WORKFLOW_ID)!;
    expect(fanout).toBeDefined();
    expect(fanout.document.pipelines).toHaveLength(2);
    expect(fanout.document.dependencies).toEqual([
      { from: 'parallel_hubs', to: 'export_hub_report', on: 'success' },
    ]);
    const fanoutTypes = new Set(
      fanout.document.pipelines.flatMap((p) => p.pipes.map((pipe) => pipe.type)),
    );
    expect(fanoutTypes).toEqual(
      new Set([
        'source.api.http.multi',
        'transform.split',
        'logic.loop',
        'transform.script',
        'transform.verify',
        'transform.condition',
        'transform.merge',
        'transform.map',
        'sink.db.sql',
        'source.db.sql',
        'sink.file.delimited',
      ]),
    );

    const crossDb = byId.get(SAMPLE_CROSS_DB_ETL_SPLIT_WORKFLOW_ID)!;
    expect(crossDb).toBeDefined();
    expect(crossDb.document.pipelines).toHaveLength(3);
    expect(crossDb.document.dependencies).toEqual([
      { from: 'seed_source_db', to: 'etl_pg_to_sqlite_and_split', on: 'success' },
      { from: 'etl_pg_to_sqlite_and_split', to: 'etl_reverse_sqlite_to_pg_audit', on: 'success' },
    ]);
    const crossDbSourceDialects = new Set(
      crossDb.document.pipelines
        .flatMap((p) => p.pipes)
        .filter((pipe) => pipe.type === 'source.db.sql')
        .map((pipe) => pipe.config.dialect),
    );
    expect(crossDbSourceDialects).toEqual(new Set(['postgres', 'sqlite']));

    for (const id of [
      SAMPLE_API_ENRICH_MULTI_DB_WORKFLOW_ID,
      SAMPLE_FILE_CSV_MULTI_PIPELINE_WORKFLOW_ID,
      SAMPLE_MULTI_API_FANOUT_WORKFLOW_ID,
      SAMPLE_CROSS_DB_ETL_SPLIT_WORKFLOW_ID,
    ]) {
      const dialects = new Set(
        byId
          .get(id)!
          .document.pipelines.flatMap((p) => p.pipes)
          .filter((pipe) => pipe.type === 'sink.db.sql')
          .map((pipe) => pipe.config.dialect),
      );
      expect(dialects).toEqual(new Set(['postgres', 'sqlite']));
    }
  });

  it('samplesAlreadyInstalled is true only when every sample id is present', () => {
    expect(samplesAlreadyInstalled([])).toBe(false);
    expect(samplesAlreadyInstalled([SAMPLE_HELLO_WORKFLOW_ID])).toBe(false);
    expect(samplesAlreadyInstalled(sampleWorkflowIds())).toBe(true);
    expect(samplesAlreadyInstalled(['other'])).toBe(false);
  });

  it('Add samples opens the branch workflow, not only the starter', () => {
    expect(SAMPLE_CANVAS_ID).toBe(SAMPLE_ORDERS_WORKFLOW_ID);
    expect(sampleForCanvas().id).toBe(SAMPLE_ORDERS_WORKFLOW_ID);
  });

  it('multi-DB ETL sample persists its quarantined rows instead of dropping them', () => {
    const pipeline = sample(SAMPLE_MULTI_DB_ETL_CONSOLIDATE_WORKFLOW_ID).document.pipelines.find(
      (p) => p.id === 'consolidate_to_warehouse',
    )!;
    const types = new Map(pipeline.pipes.map((p) => [p.id, p.type]));
    const sinksAfterQuarantine = pipeline.edges
      .filter((e) => e.from === 'quarantine_bad_orders')
      .map((e) => types.get(e.to));
    expect(sinksAfterQuarantine).toEqual(
      expect.arrayContaining(['sink.db.sql', 'sink.file.delimited']),
    );
  });

  it('dedupe-nulls sample script properly deduplicates and parses currency strings', () => {
    const found = sample(SAMPLE_DEDUPE_NULLS_QUARANTINE_ETL_WORKFLOW_ID);
    const parsed = parseWorkflow(found.document);
    const pipeline = parsed.pipelines[0]!;
    const scriptPipe = pipeline.pipes.find((p) => p.id === 'cleanse_and_dedupe');
    expect(scriptPipe).toBeDefined();

    const fn = new Function('records', scriptPipe!.config.script as string);
    const result = fn(SAMPLE_DIRTY_ETL_RECORDS) as Record<string, unknown>[];

    expect(result).toHaveLength(5);

    const rec301 = result.find((r) => r.id === 301)!;
    expect(rec301.amount).toBe(1350);
    expect(rec301.name).toContain('東京 🚀');

    const rec302 = result.find((r) => r.id === 302)!;
    expect(rec302.amount).toBe(0);
    expect(rec302.name).toBe('Müller; DROP TABLE users;--');

    // ID 303 had whitespace name ('   ') and null email -> both trimmed to empty string
    const rec303 = result.find((r) => r.id === 303)!;
    expect(rec303.name).toBe('');
    expect(rec303.email).toBe('');

    // ID 304 had negative amount (-42.5)
    const rec304 = result.find((r) => r.id === 304)!;
    expect(rec304.amount).toBe(-42.5);

    // ID 305 had invalid non-numeric string ('not-a-number') -> parsed to -1
    const rec305 = result.find((r) => r.id === 305)!;
    expect(rec305.amount).toBe(-1);
  });

  it('partial-failure recovery sample script maps merged payload into healthy vs dead-letter rows', () => {
    const found = sample(SAMPLE_PARTIAL_FAILURE_RECOVERY_WORKFLOW_ID);
    const parsed = parseWorkflow(found.document);
    const pipeline = parsed.pipelines[0]!;
    const scriptPipe = pipeline.pipes.find((p) => p.id === 'classify_endpoint_health');
    expect(scriptPipe).toBeDefined();

    const simulatedMerged = [
      {
        tokyo: { current_weather: { temperature: 18.5 } },
        paris: { current_weather: { temperature: 21.0 } },
        broken_hub: { ok: false, error: 'HTTP 404 Not Found' },
      },
    ];

    const fn = new Function('records', scriptPipe!.config.script as string);
    const result = fn(simulatedMerged) as {
      id: number;
      endpoint: string;
      has_error: boolean;
      temp_c: number;
      error_message: string;
    }[];

    expect(result).toHaveLength(3);
    const tokyo = result.find((r) => r.endpoint === 'tokyo')!;
    expect(tokyo.has_error).toBe(false);
    expect(tokyo.temp_c).toBe(18.5);

    const paris = result.find((r) => r.endpoint === 'paris')!;
    expect(paris.has_error).toBe(false);
    expect(paris.temp_c).toBe(21.0);

    const broken = result.find((r) => r.endpoint === 'broken_hub')!;
    expect(broken.has_error).toBe(true);
    expect(broken.error_message).toContain('HTTP 404');
  });

  it('CDC watermark sample script computes audit hashes and USD balance from cents', () => {
    const found = sample('sample-cdc-watermark-incremental-sync');
    const parsed = parseWorkflow(found.document);
    const scriptPipe = parsed.pipelines[0]!.pipes.find((p) => p.id === 'compute_delta_and_audit');
    expect(scriptPipe).toBeDefined();

    const fn = new Function('records', scriptPipe!.config.script as string);
    const input = [
      {
        customer_id: 'CUST-1',
        name: 'Alpha Co',
        plan: 'pro',
        balance_cents: 25400,
        op: 'UPDATE',
        updated_at: '2026-11-20T01:00:00Z',
      },
    ];
    const out = fn(input) as {
      customer_id: string;
      customer_name: string;
      subscription_tier: string;
      balance_usd: number;
      change_op: string;
      audit_id: string;
    }[];

    expect(out).toHaveLength(1);
    expect(out[0]!.customer_id).toBe('CUST-1');
    expect(out[0]!.customer_name).toBe('Alpha Co');
    expect(out[0]!.subscription_tier).toBe('PRO');
    expect(out[0]!.balance_usd).toBe(254);
    expect(out[0]!.change_op).toBe('UPDATE');
    expect(out[0]!.audit_id).toContain('AUDIT-CUST-1');
  });

  it('webhook ingest and rollup sample scripts flatten nested lines and compute category rollups', () => {
    const found = sample('sample-webhook-ingest-aggregate-db');
    const parsed = parseWorkflow(found.document);
    const flattenPipe = parsed.pipelines[0]!.pipes.find((p) => p.id === 'flatten_nested_items');
    expect(flattenPipe).toBeDefined();

    const flattenFn = new Function('records', flattenPipe!.config.script as string);
    const nestedEvents = [
      {
        order_id: 'ORD-1',
        region: 'US',
        items: [
          { item_id: 'IT-1', sku: 'SKU-A', category: 'Gadgets', qty: 3, unit_price: 10 },
          { item_id: 'IT-2', sku: 'SKU-B', category: 'Books', qty: 1, unit_price: 25 },
        ],
      },
    ];
    const flattened = flattenFn(nestedEvents) as {
      item_id: string;
      order_id: string;
      category: string;
      total_amount: number;
    }[];

    expect(flattened).toHaveLength(2);
    expect(flattened[0]!.item_id).toBe('IT-1');
    expect(flattened[0]!.total_amount).toBe(30);
    expect(flattened[1]!.item_id).toBe('IT-2');
    expect(flattened[1]!.total_amount).toBe(25);

    const rollupPipe = parsed.pipelines[1]!.pipes.find((p) => p.id === 'compute_category_totals');
    expect(rollupPipe).toBeDefined();
    const rollupFn = new Function('records', rollupPipe!.config.script as string);
    const rollups = rollupFn(flattened) as {
      category: string;
      total_items: number;
      total_revenue: number;
      avg_line_amount: number;
    }[];

    expect(rollups).toHaveLength(2);
    const gadgets = rollups.find((r) => r.category === 'Gadgets')!;
    expect(gadgets.total_items).toBe(3);
    expect(gadgets.total_revenue).toBe(30);
    expect(gadgets.avg_line_amount).toBe(30);
  });

  it('mapped db composite upsert sample defines side-by-side mapping with combination keys and condition', () => {
    const parsed = parseWorkflow(sample(SAMPLE_MAPPED_DB_COMPOSITE_UPSERT_WORKFLOW_ID).document);
    expect(parsed.pipelines).toHaveLength(1);
    const sinkPipe = parsed.pipelines[0]!.pipes.find((p) => p.id === 'mapped_insert');
    expect(sinkPipe).toBeDefined();
    expect(sinkPipe!.type).toBe('sink.db.mapped-insert');
    expect(sinkPipe!.config.mode).toBe('mapped');
    expect(sinkPipe!.config.table).toBe('wf_tenant_users');
    expect(sinkPipe!.config.upsertKeys).toEqual(['tenant_id', 'user_id']);
    expect(sinkPipe!.config.upsertCondition).toBe('EXCLUDED.updated_at >= target.updated_at');

    const mappings = sinkPipe!.config.columnMapping as Array<{
      targetColumn: string;
      sourcePath: string;
      expression?: string;
      defaultValue?: unknown;
      isKey?: boolean;
    }>;
    expect(mappings).toHaveLength(7);
    expect(mappings.find((m) => m.targetColumn === 'tenant_id')?.isKey).toBe(true);
    expect(mappings.find((m) => m.targetColumn === 'user_id')?.isKey).toBe(true);
    expect(mappings.find((m) => m.targetColumn === 'balance_usd')?.expression).toBe('value / 100');
  });

  it('saveSampleWorkflows PUTs each sample by id', async () => {
    const save = vi.fn(async () => ({}));
    await expect(saveSampleWorkflows(save)).resolves.toEqual(sampleWorkflowIds());
    expect(save).toHaveBeenCalledTimes(WORKFLOW_SAMPLES.length);
    expect(save).toHaveBeenNthCalledWith(1, SAMPLE_HELLO_WORKFLOW_ID, WORKFLOW_SAMPLES[0]!.document);
  });

  it('DBA samples define valid SQLite audit, retention dependency, and ledger quarantine pipelines', () => {
    const audit = parseWorkflow(sample(SAMPLE_DBA_SCHEMA_HEALTH_AUDIT_WORKFLOW_ID).document);
    expect(audit.tags).toContain('dba');
    expect(audit.pipelines).toHaveLength(1);

    const retention = parseWorkflow(sample(SAMPLE_DBA_RETENTION_MAINTENANCE_WORKFLOW_ID).document);
    expect(retention.pipelines).toHaveLength(2);
    expect(retention.dependencies).toEqual([
      { from: 'archive_before_purge', to: 'purge_and_analyze', on: 'success' },
    ]);

    const ledger = parseWorkflow(sample(SAMPLE_DBA_QUARANTINE_RECONCILE_WORKFLOW_ID).document);
    expect(ledger.pipelines[0]!.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'verify_ledger_rules', to: 'promote_clean_rows', fromPort: 'out' }),
        expect.objectContaining({ from: 'verify_ledger_rules', to: 'format_quarantine', fromPort: 'rejects' }),
      ]),
    );
  });
});
