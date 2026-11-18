/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/utility/src/connectors.test.ts).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PipeContext } from '../../registry/index.js';
import {
  CronTriggerSourcePipe,
  ManualTriggerSourcePipe,
  TriggerPayloadSourcePipe,
  WebhookTriggerSourcePipe,
} from '../trigger/index.js';
import { HttpSourcePipe } from '../http/index.js';
import {
  PostgresSinkPipe,
  type PostgresClient,
} from '../db/index.js';
import {
  ConditionPipe,
  CsvSourcePipe,
  MapPipe,
} from './index.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

function context(
  type: string,
  role: 'source' | 'transform' | 'sink',
  config: Record<string, unknown>,
): PipeContext {
  return {
    workflowRunId: 'run',
    pipelineId: 'pipeline',
    pipe: { id: type, type, role, config, concurrency: 1 },
  };
}

describe('built-in connectors', () => {
  it('streams quoted CSV rows in stable batches and resumes from a row cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foxflow-csv-'));
    cleanup.push(directory);
    const path = join(directory, 'records.csv');
    await writeFile(path, 'id,name\n1,"Ada, A."\n2,"Grace"\n3,"Linus"\n');
    const connector = new CsvSourcePipe();
    const ctx = context('source.csv', 'source', { path, batchSize: 2 });
    ctx.checkpoint = {
      workflowRunId: 'run',
      pipelineId: 'pipeline',
      pipeId: 'source.csv',
      partitionId: '0',
      cursor: { row: 1 },
      updatedAt: new Date().toISOString(),
    };

    const batches = [];
    for await (const batch of connector.read(ctx)) batches.push(batch);

    expect(batches).toEqual([
      expect.objectContaining({
        id: 'source.csv:0:2-3',
        records: [
          { id: '2', name: 'Grace' },
          { id: '3', name: 'Linus' },
        ],
        cursor: { row: 3 },
      }),
    ]);
  });

  it('validates HTTP URLs and reads a configured records path', async () => {
    const connector = new HttpSourcePipe(async () =>
      new Response(JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const batches = [];
    for await (const batch of connector.read(
      context('source.http', 'source', {
        url: 'https://example.test/records',
        recordsPath: 'data',
        batchSize: 1,
      }),
    )) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.id)).toEqual([
      'source.http:0:0-0',
      'source.http:0:1-1',
    ]);
    expect(() =>
      connector.validateConfig?.({ url: 'file:///etc/passwd' }),
    ).toThrow(/http/);
  });

  it('turns a trigger invocation payload into a stable record batch', async () => {
    const connector = new TriggerPayloadSourcePipe();
    const ctx = context('source.triggerPayload', 'source', {});
    ctx.invocation = {
      id: 'invocation-42',
      workflowId: 'workflow',
      triggerId: 'webhook',
      kind: 'webhook',
      acceptedAt: '2026-07-14T00:00:00.000Z',
      payload: [{ id: 1 }, { id: 2 }],
      metadata: {},
    };

    const batches = [];
    for await (const batch of connector.read(ctx)) batches.push(batch);

    expect(batches).toEqual([
      {
        id: 'source.triggerPayload:0:invocation-42',
        partitionId: '0',
        records: [{ id: 1 }, { id: 2 }],
        cursor: { invocationId: 'invocation-42' },
      },
    ]);
  });

  it('exposes kind-specific trigger source pipes', async () => {
    const manual = new ManualTriggerSourcePipe();
    const manualCtx = context('source.trigger.manual', 'source', {});
    manualCtx.invocation = {
      id: 'inv-manual',
      workflowId: 'workflow',
      triggerId: 'manual',
      kind: 'manual',
      acceptedAt: '2026-07-14T00:00:00.000Z',
      metadata: {},
    };
    const manualBatches = [];
    for await (const batch of manual.read(manualCtx)) manualBatches.push(batch);
    expect(manualBatches[0]?.records).toEqual([
      expect.objectContaining({
        triggered: true,
        triggerId: 'manual',
        kind: 'manual',
      }),
    ]);

    // With pre-start input data the manual pipe emits it instead of the
    // synthetic "triggered" record.
    const withInput = new ManualTriggerSourcePipe();
    const withInputCtx = context('source.trigger.manual', 'source', {});
    withInputCtx.invocation = {
      id: 'inv-manual-input',
      workflowId: 'workflow',
      triggerId: 'manual',
      kind: 'manual',
      acceptedAt: '2026-07-14T00:00:00.000Z',
      payload: [{ sku: 'A-1' }, { sku: 'B-2' }],
      metadata: {},
    };
    const withInputBatches = [];
    for await (const batch of withInput.read(withInputCtx)) {
      withInputBatches.push(batch);
    }
    expect(withInputBatches[0]?.records).toEqual([
      { sku: 'A-1' },
      { sku: 'B-2' },
    ]);

    const cron = new CronTriggerSourcePipe();
    const cronCtx = context('source.trigger.cron', 'source', {});
    cronCtx.invocation = {
      id: 'inv-cron',
      workflowId: 'workflow',
      triggerId: 'nightly',
      kind: 'cron',
      acceptedAt: '2026-07-14T00:00:00.000Z',
      payload: { scheduledAt: '2026-07-14T00:00:00.000Z' },
      metadata: {},
    };
    const cronBatches = [];
    for await (const batch of cron.read(cronCtx)) cronBatches.push(batch);
    expect(cronBatches[0]?.records[0]).toMatchObject({
      kind: 'cron',
      scheduledAt: '2026-07-14T00:00:00.000Z',
    });

    // A SQL schedule's rows become the records, one each — not one record
    // wrapping the array.
    const sqlCtx = context('source.trigger.cron', 'source', {});
    sqlCtx.invocation = {
      ...cronCtx.invocation,
      id: 'inv-cron-sql',
      payload: {
        scheduledAt: '2026-07-14T00:00:00.000Z',
        rowCount: 2,
        rows: [{ id: 1, sku: 'A-1' }, { id: 2, sku: 'B-2' }],
      },
    };
    const sqlBatches = [];
    for await (const batch of new CronTriggerSourcePipe().read(sqlCtx)) sqlBatches.push(batch);
    expect(sqlBatches[0]?.records).toEqual([
      { id: 1, sku: 'A-1' },
      { id: 2, sku: 'B-2' },
    ]);

    // No rows (a schedule set to run regardless) still gives the pipeline the
    // tick, without an empty `rows` array riding along.
    const emptyCtx = context('source.trigger.cron', 'source', {});
    emptyCtx.invocation = {
      ...cronCtx.invocation,
      id: 'inv-cron-sql-empty',
      payload: { scheduledAt: '2026-07-14T00:00:00.000Z', rowCount: 0, rows: [] },
    };
    const emptyBatches = [];
    for await (const batch of new CronTriggerSourcePipe().read(emptyCtx)) emptyBatches.push(batch);
    expect(emptyBatches[0]?.records).toEqual([
      {
        triggerId: 'nightly',
        kind: 'cron',
        acceptedAt: '2026-07-14T00:00:00.000Z',
        scheduledAt: '2026-07-14T00:00:00.000Z',
        rowCount: 0,
      },
    ]);

    const webhook = new WebhookTriggerSourcePipe();
    const wrong = context('source.trigger.webhook', 'source', {});
    wrong.invocation = {
      id: 'inv-cron-wrong',
      workflowId: 'workflow',
      triggerId: 'nightly',
      kind: 'cron',
      acceptedAt: '2026-07-14T00:00:00.000Z',
      payload: { id: 1 },
      metadata: {},
    };
    await expect(async () => {
      for await (const _ of webhook.read(wrong)) {
        // drain
      }
    }).rejects.toThrow(/expects a webhook trigger/);
  });

  it('maps records and routes condition ports', async () => {
    const input = {
      id: 'batch',
      partitionId: '0',
      records: [
        { user: { name: 'Ada' }, active: true },
        { user: { name: 'Grace' }, active: false },
      ],
    };
    const mapped = await new MapPipe().transform(
      input,
      context('transform.map', 'transform', {
        mappings: { name: 'user.name' },
        includeOriginal: false,
      }),
    );
    const filtered = await new ConditionPipe().transform(
      input,
      context('transform.condition', 'transform', {
        field: 'active',
        operator: 'equals',
        value: true,
      }),
    );
    expect(mapped?.records).toEqual([{ name: 'Ada' }, { name: 'Grace' }]);
    expect(filtered.get('true')?.records).toEqual([
      { user: { name: 'Ada' }, active: true },
    ]);
    expect(filtered.get('false')?.records).toEqual([
      { user: { name: 'Grace' }, active: false },
    ]);
  });

  it('accepts the op/gt spelling that Verify rules and trigger conditions use', async () => {
    const batch = {
      id: 'b',
      partitionId: '0',
      records: [{ amount: 5 }, { amount: 50 }],
    };
    const pipe = new ConditionPipe();
    const short = { field: 'amount', op: 'gt', value: 10 };
    expect(() => pipe.validateConfig(short)).not.toThrow();
    const routed = await pipe.transform(batch, context('transform.condition', 'transform', short));
    expect(routed.get('true')?.records).toEqual([{ amount: 50 }]);
    expect(routed.get('false')?.records).toEqual([{ amount: 5 }]);

    // The long form still wins when both are present.
    const both = await pipe.transform(
      batch,
      context('transform.condition', 'transform', { field: 'amount', operator: 'lessThan', op: 'gt', value: 10 }),
    );
    expect(both.get('true')?.records).toEqual([{ amount: 5 }]);
    expect(() => pipe.validateConfig({ field: 'amount', op: 'bogus' })).toThrow();
  });

  it('deduplicates PostgreSQL batch commits by stable batch id', async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const committed = new Set<string>();
    const client: PostgresClient = {
      async connect() {},
      async end() {},
      async query(text, values) {
        queries.push({ text, values });
        if (text.includes('_foxflow_committed_batches') && text.includes('INSERT')) {
          const id = String(values?.[0]);
          if (committed.has(id)) return { rowCount: 0, rows: [] };
          committed.add(id);
          return { rowCount: 1, rows: [{ batch_id: id }] };
        }
        return { rowCount: 1, rows: [] };
      },
    };
    const connector = new PostgresSinkPipe(async () => client);
    const ctx = context('sink.postgres', 'sink', {
      table: 'people',
      columns: { id: 'integer', name: 'text' },
    });
    const batch = {
      id: 'stable-batch',
      partitionId: '0',
      records: [{ id: 1, name: 'Ada' }],
    };

    await connector.write(batch, ctx);
    await connector.write(batch, ctx);

    expect(
      queries.filter((query) =>
        query.text.startsWith('INSERT INTO "public"."people"'),
      ),
    ).toHaveLength(1);
  });
});
