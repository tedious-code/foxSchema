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
  SAMPLE_FILE_CSV_MULTI_PIPELINE_WORKFLOW_ID,
  SAMPLE_HELLO_PEOPLE,
  SAMPLE_HELLO_WORKFLOW_ID,
  SAMPLE_MULTI_API_FANOUT_WORKFLOW_ID,
  SAMPLE_ORDERS,
  SAMPLE_ORDERS_WORKFLOW_ID,
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
    expect(WORKFLOW_SAMPLES.length).toBeGreaterThanOrEqual(9);
    for (const entry of WORKFLOW_SAMPLES) {
      const parsed = parseWorkflow(entry.document);
      expect(parsed.id).toBe(entry.id);
      expect(parsed.pipelines.length).toBeGreaterThan(0);
      expect(parsed.pipelines[0]!.pipes.length).toBeGreaterThan(0);
    }
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

  it('saveSampleWorkflows PUTs each sample by id', async () => {
    const save = vi.fn(async () => ({}));
    await expect(saveSampleWorkflows(save)).resolves.toEqual(sampleWorkflowIds());
    expect(save).toHaveBeenCalledTimes(WORKFLOW_SAMPLES.length);
    expect(save).toHaveBeenNthCalledWith(1, SAMPLE_HELLO_WORKFLOW_ID, WORKFLOW_SAMPLES[0]!.document);
  });
});
