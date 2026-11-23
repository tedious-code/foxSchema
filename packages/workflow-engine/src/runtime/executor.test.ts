/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/runtime/src/executor.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type {
  Checkpoint,
  CheckpointStore,
  EventStore,
  NewRunEvent,
  PipeDef,
  PipelineDef,
  PipeRunRecord,
  RunEvent,
  RunStore,
} from '../common/index.js';
import {
  PipeRegistry,
  type RecordBatch,
  type SourcePipe,
  type TransformPipe,
  type SinkPipe,
} from '../registry/index.js';
import {
  PipelineExecutor,
  TransientExecutionError,
} from './executor.js';

class MemoryEvents implements EventStore {
  readonly events: RunEvent[] = [];
  private seq = 0;

  async append(event: NewRunEvent): Promise<RunEvent> {
    const row: RunEvent = { ...event, seq: ++this.seq };
    this.events.push(row);
    return row;
  }

  async list(workflowRunId: string, afterSeq = 0): Promise<RunEvent[]> {
    return this.events.filter(
      (event) =>
        event.workflowRunId === workflowRunId && event.seq > afterSeq,
    );
  }
}

class MemoryCheckpoints implements CheckpointStore {
  readonly rows = new Map<string, Checkpoint>();

  async put(checkpoint: Checkpoint): Promise<void> {
    this.rows.set(this.key(
      checkpoint.workflowRunId,
      checkpoint.pipelineId,
      checkpoint.pipeId,
      checkpoint.partitionId,
    ), checkpoint);
  }

  async get(run: string, pipeline: string, pipe: string, partition: string) {
    return this.rows.get(this.key(run, pipeline, pipe, partition));
  }

  async list(run: string): Promise<Checkpoint[]> {
    return [...this.rows.values()].filter((row) => row.workflowRunId === run);
  }

  private key(run: string, pipeline: string, pipe: string, partition: string) {
    return `${run}/${pipeline}/${pipe}/${partition}`;
  }
}

const sourcePipe: PipeDef = {
  id: 'source',
  role: 'source',
  type: 'test.source',
  config: {},
  concurrency: 1,
};

function pipeline(pipes: PipeDef[], edges: PipelineDef['edges']): PipelineDef {
  return { id: 'pipeline', name: 'pipeline', pipes, edges };
}

describe('PipelineExecutor', () => {
  it('streams batches through a transform into a sink with backpressure', async () => {
    const written: RecordBatch[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const source: SourcePipe = {
      type: 'test.source',
      role: 'source',
      async *read() {
        yield batch('a', 1);
        yield batch('b', 2);
      },
    };
    const map: TransformPipe = {
      type: 'test.map',
      role: 'transform',
      async transform(input) {
        return {
          ...input,
          records: input.records.map((row) => ({
            ...row,
            value: Number(row.value) * 2,
          })),
        };
      },
    };
    const sink: SinkPipe = {
      type: 'test.sink',
      role: 'sink',
      async write(input) {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 2));
        written.push(input);
        activeWrites--;
      },
    };
    const registry = new PipeRegistry([source, map, sink]);
    const executor = new PipelineExecutor({ registry });

    await executor.execute(
      pipeline(
        [
          sourcePipe,
          { id: 'map', role: 'transform', type: 'test.map', config: {}, concurrency: 1 },
          { id: 'sink', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 },
        ],
        [
          { from: 'source', to: 'map' },
          { from: 'map', to: 'sink' },
        ],
      ),
      { workflowRunId: 'run-1' },
    );

    expect(written.flatMap((item) => item.records)).toEqual([
      { value: 2 },
      { value: 4 },
    ]);
    expect(maxActiveWrites).toBe(1);
  });

  it('runs independent downstream branches concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const branchSink = (type: string): SinkPipe => ({
      type,
      role: 'sink',
      async write() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      },
    });
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read() {
          yield batch('a', 1);
        },
      },
      branchSink('test.left'),
      branchSink('test.right'),
    ]);
    const executor = new PipelineExecutor({ registry });

    await executor.execute(
      pipeline(
        [
          sourcePipe,
          { id: 'left', role: 'sink', type: 'test.left', config: {}, concurrency: 1 },
          { id: 'right', role: 'sink', type: 'test.right', config: {}, concurrency: 1 },
        ],
        [
          { from: 'source', to: 'left' },
          { from: 'source', to: 'right' },
        ],
      ),
      { workflowRunId: 'run-1' },
    );

    expect(maxActive).toBe(2);
  });

  it('retries transient pipe failures and checkpoints committed batches', async () => {
    const checkpoints = new MemoryCheckpoints();
    let writes = 0;
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read() {
          yield batch('stable-id', 1);
        },
      },
      {
        type: 'test.sink',
        role: 'sink',
        async write() {
          writes++;
          if (writes === 1) throw new TransientExecutionError('try again');
        },
      },
    ]);
    const executor = new PipelineExecutor({ registry, checkpoints });

    await executor.execute(
      pipeline(
        [
          sourcePipe,
          {
            id: 'sink',
            role: 'sink',
            type: 'test.sink',
            config: {},
            concurrency: 1,
            retry: {
              attempts: 1,
              backoff: 'fixed',
              maxDelayMs: 0,
              jitter: false,
              on: 'transient',
            },
          },
        ],
        [{ from: 'source', to: 'sink' }],
      ),
      { workflowRunId: 'run-1' },
    );

    expect(writes).toBe(2);
    expect(await checkpoints.get('run-1', 'pipeline', 'source', '0')).toMatchObject({
      cursor: { row: 1 },
    });
  });

  it('stops before another batch when cancelled', async () => {
    const controller = new AbortController();
    let writes = 0;
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read() {
          yield batch('a', 1);
          yield batch('b', 2);
        },
      },
      {
        type: 'test.sink',
        role: 'sink',
        async write() {
          writes++;
          controller.abort();
        },
      },
    ]);

    await expect(
      new PipelineExecutor({ registry }).execute(
        pipeline(
          [
            sourcePipe,
            { id: 'sink', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 },
          ],
          [{ from: 'source', to: 'sink' }],
        ),
        { workflowRunId: 'run-1', signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(writes).toBe(1);
  });

  it('passes the committed source checkpoint back to a resumed source', async () => {
    const checkpoints = new MemoryCheckpoints();
    await checkpoints.put({
      workflowRunId: 'run-1',
      pipelineId: 'pipeline',
      pipeId: 'source',
      partitionId: '0',
      cursor: { row: 1 },
      updatedAt: '2026-07-13T00:00:00.000Z',
    });
    const values: number[] = [];
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read(context) {
          const next = Number(context.checkpoint?.cursor.row ?? 0) + 1;
          yield batch('resumed', next);
        },
      },
      {
        type: 'test.sink',
        role: 'sink',
        async write(input) {
          values.push(Number(input.records[0]!.value));
        },
      },
    ]);

    await new PipelineExecutor({ registry, checkpoints }).execute(
      pipeline(
        [
          sourcePipe,
          { id: 'sink', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 },
        ],
        [{ from: 'source', to: 'sink' }],
      ),
      { workflowRunId: 'run-1' },
    );

    expect(values).toEqual([2]);
  });

  describe('a failure downstream', () => {
    /** Last status (and message) each pipe reported, from the event log. */
    function finalStatuses(events: MemoryEvents): Record<string, { status: unknown; message?: string }> {
      const out: Record<string, { status: unknown; message?: string }> = {};
      for (const event of events.events) {
        if (!event.pipeId || (event.type !== 'pipe.status' && event.type !== 'batch.progress')) continue;
        out[event.pipeId] = { status: event.data?.status, ...(event.message ? { message: event.message } : {}) };
      }
      return out;
    }

    function chain(sourceExtra: Partial<PipeDef> = {}) {
      return pipeline(
        [
          { ...sourcePipe, ...sourceExtra },
          { id: 'shape', role: 'transform', type: 'test.transform', config: {}, concurrency: 1 },
          { id: 'sink', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 },
        ],
        [
          { from: 'source', to: 'shape' },
          { from: 'shape', to: 'sink' },
        ],
      );
    }

    function registry(reads: { count: number }, sourceOnError?: () => 'skip') {
      return new PipeRegistry([
        {
          type: 'test.source',
          role: 'source',
          async *read() {
            reads.count++;
            yield batch('a', 1);
          },
          ...(sourceOnError ? { onError: sourceOnError } : {}),
        },
        { type: 'test.transform', role: 'transform', async transform(input: RecordBatch) { return input; } },
        {
          type: 'test.sink',
          role: 'sink',
          async write() {
            throw new Error('boom: sink failed');
          },
        },
      ]);
    }

    it('is recorded on the pipe that failed; the pipes upstream are stopped, not failed', async () => {
      const events = new MemoryEvents();
      await expect(
        new PipelineExecutor({ registry: registry({ count: 0 }), events }).execute(chain(), {
          workflowRunId: 'run-downstream',
        }),
      ).rejects.toThrow('boom: sink failed');

      expect(finalStatuses(events)).toEqual({
        sink: { status: 'failed', message: 'boom: sink failed' },
        shape: { status: 'cancelled', message: 'Stopped because pipe sink failed.' },
        source: { status: 'cancelled', message: 'Stopped because pipe sink failed.' },
      });
    });

    it("does not trigger the source's own retry policy", async () => {
      const reads = { count: 0 };
      await expect(
        new PipelineExecutor({ registry: registry(reads) }).execute(
          chain({ retry: { attempts: 3, backoff: 'fixed', maxDelayMs: 0, jitter: false, on: 'all' } }),
          { workflowRunId: 'run-no-reread' },
        ),
      ).rejects.toThrow('boom: sink failed');
      // Re-reading the source because the sink failed would write it all again.
      expect(reads.count).toBe(1);
    });

    it("is not swallowed by the source's onError skip", async () => {
      await expect(
        new PipelineExecutor({ registry: registry({ count: 0 }, () => 'skip') }).execute(chain(), {
          workflowRunId: 'run-no-skip',
        }),
      ).rejects.toThrow('boom: sink failed');
    });
  });

  it('honors connector onError skip without failing the pipeline', async () => {
    const written: RecordBatch[] = [];
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read() {
          yield batch('a', 1);
        },
      },
      {
        type: 'test.sink',
        role: 'sink',
        async write() {
          throw new Error('temporary sink failure');
        },
        onError() {
          return 'skip';
        },
      },
    ]);

    await new PipelineExecutor({ registry }).execute(
      pipeline(
        [
          sourcePipe,
          { id: 'sink', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 },
        ],
        [{ from: 'source', to: 'sink' }],
      ),
      { workflowRunId: 'run-skip' },
    );
    expect(written).toEqual([]);
  });

  it('injects InfrastructureContext into connector contexts', async () => {
    let sawInfrastructure = false;
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read(context) {
          sawInfrastructure = Boolean(context.infrastructure?.http.fetch);
          yield batch('a', 1);
        },
      },
      {
        type: 'test.sink',
        role: 'sink',
        async write() {},
      },
    ]);

    await new PipelineExecutor({ registry }).execute(
      pipeline(
        [
          sourcePipe,
          { id: 'sink', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 },
        ],
        [{ from: 'source', to: 'sink' }],
      ),
      { workflowRunId: 'run-infra' },
    );
    expect(sawInfrastructure).toBe(true);
  });

  it('routes condition batches to named fromPort edges', async () => {
    const trueWrites: RecordBatch[] = [];
    const falseWrites: RecordBatch[] = [];
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read() {
          yield {
            id: 'rows',
            partitionId: '0',
            records: [
              { id: 1, active: true },
              { id: 2, active: false },
              { id: 3, active: true },
            ],
          };
        },
      },
      {
        type: 'test.condition',
        role: 'transform',
        metadata: () => ({
          type: 'test.condition',
          name: 'Condition',
          category: 'Transform',
          version: '0.1.0',
          role: 'transform',
          inputs: [{ name: 'in', type: 'records' }],
          outputs: [
            { name: 'true', type: 'records' },
            { name: 'false', type: 'records' },
          ],
          configSchema: {},
        }),
        async transform(input) {
          const ports = new Map<string, RecordBatch>();
          const yes = input.records.filter((row) => row.active === true);
          const no = input.records.filter((row) => row.active !== true);
          if (yes.length) {
            ports.set('true', { ...input, id: `${input.id}:true`, records: yes });
          }
          if (no.length) {
            ports.set('false', {
              ...input,
              id: `${input.id}:false`,
              records: no,
            });
          }
          return ports;
        },
      },
      {
        type: 'test.sink.true',
        role: 'sink',
        async write(input) {
          trueWrites.push(input);
        },
      },
      {
        type: 'test.sink.false',
        role: 'sink',
        async write(input) {
          falseWrites.push(input);
        },
      },
    ]);

    await new PipelineExecutor({ registry }).execute(
      pipeline(
        [
          sourcePipe,
          {
            id: 'if',
            role: 'transform',
            type: 'test.condition',
            config: {},
            concurrency: 1,
          },
          {
            id: 'yes',
            role: 'sink',
            type: 'test.sink.true',
            config: {},
            concurrency: 1,
          },
          {
            id: 'no',
            role: 'sink',
            type: 'test.sink.false',
            config: {},
            concurrency: 1,
          },
        ],
        [
          { from: 'source', to: 'if' },
          { from: 'if', to: 'yes', fromPort: 'true' },
          { from: 'if', to: 'no', fromPort: 'false' },
        ],
      ),
      { workflowRunId: 'run-ports' },
    );

    expect(trueWrites[0]?.records.map((row) => row.id)).toEqual([1, 3]);
    expect(falseWrites[0]?.records.map((row) => row.id)).toEqual([2]);
  });

  it('emits per-port batch.sample events when debug is enabled', async () => {
    const events = new MemoryEvents();
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read() {
          yield {
            id: 'rows',
            partitionId: '0',
            records: [
              { id: 1, active: true },
              { id: 2, active: false },
            ],
          };
        },
      },
      {
        type: 'test.condition',
        role: 'transform',
        metadata: () => ({
          type: 'test.condition',
          name: 'Condition',
          category: 'Transform',
          version: '0.1.0',
          role: 'transform',
          inputs: [{ name: 'in', type: 'records' }],
          outputs: [
            { name: 'true', type: 'records' },
            { name: 'false', type: 'records' },
          ],
          configSchema: {},
        }),
        async transform(input) {
          const ports = new Map<string, RecordBatch>();
          const yes = input.records.filter((row) => row.active === true);
          const no = input.records.filter((row) => row.active !== true);
          if (yes.length) {
            ports.set('true', { ...input, id: `${input.id}:true`, records: yes });
          }
          if (no.length) {
            ports.set('false', {
              ...input,
              id: `${input.id}:false`,
              records: no,
            });
          }
          return ports;
        },
      },
      {
        type: 'test.sink.true',
        role: 'sink',
        async write() {},
      },
      {
        type: 'test.sink.false',
        role: 'sink',
        async write() {},
      },
    ]);

    await new PipelineExecutor({ registry, events }).execute(
      pipeline(
        [
          sourcePipe,
          {
            id: 'if',
            role: 'transform',
            type: 'test.condition',
            config: {},
            concurrency: 1,
          },
          {
            id: 'yes',
            role: 'sink',
            type: 'test.sink.true',
            config: {},
            concurrency: 1,
          },
          {
            id: 'no',
            role: 'sink',
            type: 'test.sink.false',
            config: {},
            concurrency: 1,
          },
        ],
        [
          { from: 'source', to: 'if' },
          { from: 'if', to: 'yes', fromPort: 'true' },
          { from: 'if', to: 'no', fromPort: 'false' },
        ],
      ),
      { workflowRunId: 'run-debug', debug: true },
    );

    const samples = events.events.filter((event) => event.type === 'batch.sample');
    const byKey = (pipeId: string, direction: string, port: string) =>
      samples.find(
        (event) =>
          event.pipeId === pipeId &&
          event.data?.direction === direction &&
          event.data?.port === port,
      );

    expect(byKey('source', 'out', 'out')?.data?.recordCount).toBe(2);
    expect(byKey('if', 'in', 'out')?.data?.fromPipe).toBe('source');
    expect(byKey('if', 'out', 'true')?.data?.records).toEqual([
      { id: 1, active: true },
    ]);
    expect(byKey('if', 'out', 'false')?.data?.records).toEqual([
      { id: 2, active: false },
    ]);
    expect(byKey('yes', 'in', 'true')?.data?.fromPort).toBe('true');
    expect(byKey('no', 'in', 'false')?.data?.fromPort).toBe('false');

    // Without debug, no samples.
    const quiet = new MemoryEvents();
    await new PipelineExecutor({ registry, events: quiet }).execute(
      pipeline(
        [
          sourcePipe,
          {
            id: 'if',
            role: 'transform',
            type: 'test.condition',
            config: {},
            concurrency: 1,
          },
          {
            id: 'yes',
            role: 'sink',
            type: 'test.sink.true',
            config: {},
            concurrency: 1,
          },
          {
            id: 'no',
            role: 'sink',
            type: 'test.sink.false',
            config: {},
            concurrency: 1,
          },
        ],
        [
          { from: 'source', to: 'if' },
          { from: 'if', to: 'yes', fromPort: 'true' },
          { from: 'if', to: 'no', fromPort: 'false' },
        ],
      ),
      { workflowRunId: 'run-quiet' },
    );
    expect(quiet.events.filter((event) => event.type === 'batch.sample')).toHaveLength(
      0,
    );
  });

  it('samples only the first batch per port, and caps rows and bytes', async () => {
    const events = new MemoryEvents();
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read() {
          // First batch is wide (50 rows) and then two more follow: only the
          // first may be sampled, or a long stream would flood the event log.
          yield {
            id: 'wide',
            partitionId: '0',
            records: Array.from({ length: 50 }, (_, i) => ({ id: i })),
          };
          yield { id: 'second', partitionId: '0', records: [{ id: 100 }] };
          yield { id: 'third', partitionId: '0', records: [{ id: 200 }] };
        },
      },
      { type: 'test.sink', role: 'sink', async write() {} },
    ]);

    await new PipelineExecutor({ registry, events }).execute(
      pipeline(
        [
          sourcePipe,
          { id: 'out', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 },
        ],
        [{ from: 'source', to: 'out' }],
      ),
      { workflowRunId: 'run-cap', debug: true },
    );

    const samples = events.events.filter((event) => event.type === 'batch.sample');
    // source out + sink in — one each, despite three batches flowing.
    expect(samples).toHaveLength(2);
    const sourceSample = samples.find((event) => event.pipeId === 'source')!;
    // Full batch size is still reported even though the rows are truncated.
    expect(sourceSample.data?.recordCount).toBe(50);
    expect((sourceSample.data?.records as unknown[]).length).toBe(20);
    expect(sourceSample.data?.truncated).toBe(true);
  });

  it('drops rows to stay under the byte budget, always keeping at least one', async () => {
    const events = new MemoryEvents();
    // A single record far larger than the 16KB budget.
    const huge = 'x'.repeat(40_000);
    const registry = new PipeRegistry([
      {
        type: 'test.source',
        role: 'source',
        async *read() {
          yield {
            id: 'huge',
            partitionId: '0',
            records: [{ blob: huge }, { blob: huge }],
          };
        },
      },
      { type: 'test.sink', role: 'sink', async write() {} },
    ]);

    await new PipelineExecutor({ registry, events }).execute(
      pipeline(
        [
          sourcePipe,
          { id: 'out', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 },
        ],
        [{ from: 'source', to: 'out' }],
      ),
      { workflowRunId: 'run-bytes', debug: true },
    );

    const sample = events.events.find(
      (event) => event.type === 'batch.sample' && event.pipeId === 'source',
    )!;
    // Cannot fit even one row in the budget, so one is kept and flagged.
    expect((sample.data?.records as unknown[]).length).toBe(1);
    expect(sample.data?.truncated).toBe(true);
    expect(sample.data?.recordCount).toBe(2);
  });

  it('chains trigger → source → transform → sink → sink in any order', async () => {
    const dbWrites: RecordBatch[] = [];
    const emailWrites: RecordBatch[] = [];
    let querySawTenant: unknown;
    const registry = new PipeRegistry([
      {
        type: 'source.trigger.manual',
        role: 'source',
        async *read() {
          yield {
            id: 'trig-1',
            partitionId: '0',
            records: [{ tenantId: 'acme' }],
          };
        },
      },
      {
        type: 'source.db.sql',
        role: 'source',
        async *read(context) {
          querySawTenant = context.variables?.tenantId;
          yield {
            id: 'sql-1',
            partitionId: '0',
            records: [
              { id: 1, tenantId: context.variables?.tenantId, amount: 150 },
              { id: 2, tenantId: context.variables?.tenantId, amount: 20 },
            ],
          };
        },
      },
      {
        type: 'transform.filter',
        role: 'transform',
        async transform(input) {
          return {
            ...input,
            records: input.records.filter((row) => Number(row.amount) >= 100),
          };
        },
      },
      {
        type: 'sink.db.sql',
        role: 'sink',
        async write(input) {
          dbWrites.push(input);
        },
      },
      {
        type: 'sink.notify.email',
        role: 'sink',
        async write(input) {
          emailWrites.push(input);
        },
      },
    ]);

    await new PipelineExecutor({ registry }).execute(
      pipeline(
        [
          { id: 'trigger', role: 'source', type: 'source.trigger.manual', config: {}, concurrency: 1 },
          { id: 'query', role: 'source', type: 'source.db.sql', config: {}, concurrency: 1 },
          { id: 'filter', role: 'transform', type: 'transform.filter', config: {}, concurrency: 1 },
          { id: 'write', role: 'sink', type: 'sink.db.sql', config: {}, concurrency: 1 },
          { id: 'notify', role: 'sink', type: 'sink.notify.email', config: {}, concurrency: 1 },
        ],
        [
          { from: 'trigger', to: 'query' },
          { from: 'query', to: 'filter' },
          { from: 'filter', to: 'write' },
          { from: 'write', to: 'notify' },
        ],
      ),
      { workflowRunId: 'run-chain' },
    );

    expect(querySawTenant).toBe('acme');
    expect(dbWrites.flatMap((item) => item.records)).toEqual([
      { id: 1, tenantId: 'acme', amount: 150 },
    ]);
    expect(emailWrites.flatMap((item) => item.records)).toEqual([
      { id: 1, tenantId: 'acme', amount: 150 },
    ]);
  });
});

describe('pipe run records', () => {
  it('keeps a failed pipe failed when another of its batches finishes afterwards', async () => {
    // Two sources feed one sink (a Merge does the same). The sink fails on the
    // first batch while the second is still writing; that write then succeeds.
    // The record used to take the last update, so the pipe that failed the
    // run was stored as success with its error gone.
    const pipeRecords = new Map<string, PipeRunRecord>();
    const runs = {
      putPipe: async (record: PipeRunRecord) => void pipeRecords.set(record.pipeId, record),
      listPipes: async () => [...pipeRecords.values()],
    } as unknown as RunStore;
    const events = new MemoryEvents();
    const fast: SourcePipe = {
      type: 'test.fast',
      role: 'source',
      async *read() {
        yield batch('fast', 1);
      },
    };
    const slow: SourcePipe = {
      type: 'test.slow',
      role: 'source',
      async *read() {
        yield batch('slow', 2);
      },
    };
    let slowWrite: Promise<void> | undefined;
    const sink: SinkPipe = {
      type: 'test.sink',
      role: 'sink',
      async write(input) {
        if (input.id === 'fast') {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error('cannot start a transaction within a transaction');
        }
        slowWrite = new Promise((resolve) => setTimeout(resolve, 30));
        await slowWrite;
      },
    };
    const executor = new PipelineExecutor({ registry: new PipeRegistry([fast, slow, sink]), runs, events });

    await expect(
      executor.execute(
        pipeline(
          [
            { id: 'a', role: 'source', type: 'test.fast', config: {}, concurrency: 1 },
            { id: 'b', role: 'source', type: 'test.slow', config: {}, concurrency: 1 },
            { id: 'stage', role: 'sink', type: 'test.sink', config: {}, concurrency: 2 },
          ],
          [
            { from: 'a', to: 'stage' },
            { from: 'b', to: 'stage' },
          ],
        ),
        { workflowRunId: 'run-sticky' },
      ),
    ).rejects.toThrow('cannot start a transaction within a transaction');
    // Let the slow write land and its record update drain.
    await slowWrite;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stage = pipeRecords.get('stage');
    expect(stage?.status).toBe('failed');
    expect(stage?.error).toBe('cannot start a transaction within a transaction');
    const stageEvents = events.events.filter((e) => e.pipeId === 'stage');
    expect(stageEvents.some((e) => e.data?.status === 'success')).toBe(false);
  });

  it('lets a resumed run succeed a pipe the interrupted run left cancelled', async () => {
    const pipeRecords = new Map<string, PipeRunRecord>([
      [
        'sink',
        {
          id: 'run-resume:pipeline:sink',
          workflowRunId: 'run-resume',
          pipelineId: 'pipeline',
          pipeId: 'sink',
          status: 'cancelled',
          attempt: 1,
          processedBatches: 0,
          processedRecords: 0,
          startedAt: '2026-11-22T00:00:00.000Z',
          finishedAt: '2026-11-22T00:00:01.000Z',
          error: 'interrupted',
        },
      ],
    ]);
    const runs = {
      putPipe: async (record: PipeRunRecord) => void pipeRecords.set(record.pipeId, record),
      listPipes: async () => [...pipeRecords.values()],
    } as unknown as RunStore;
    const source: SourcePipe = {
      type: 'test.source',
      role: 'source',
      async *read() {
        yield batch('a', 1);
      },
    };
    const sink: SinkPipe = { type: 'test.sink', role: 'sink', async write() {} };
    const executor = new PipelineExecutor({ registry: new PipeRegistry([source, sink]), runs });

    await executor.execute(
      pipeline(
        [sourcePipe, { id: 'sink', role: 'sink', type: 'test.sink', config: {}, concurrency: 1 }],
        [{ from: 'source', to: 'sink' }],
      ),
      { workflowRunId: 'run-resume' },
    );

    expect(pipeRecords.get('sink')).toMatchObject({ status: 'success', error: undefined, processedBatches: 1 });
  });
});

function batch(id: string, value: number): RecordBatch {
  return {
    id,
    partitionId: '0',
    records: [{ value }],
    cursor: { row: value },
  };
}
