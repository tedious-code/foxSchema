/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/pipes/http/src/multi-http.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { PipeContext } from '../../registry/index.js';
import { ScriptTransformPipe } from '../utility/script.js';
import { MultiHttpSourcePipe } from './multi-http.js';

function context(
  config: Record<string, unknown>,
  signal?: AbortSignal,
): PipeContext {
  return {
    workflowRunId: 'run',
    pipelineId: 'pipeline',
    pipe: {
      id: 'multi',
      role: 'source',
      type: 'source.api.http.multi',
      config,
      concurrency: 1,
    },
    signal,
  };
}

/** Collect every record the pipe emits for a config. */
async function collect(
  pipe: MultiHttpSourcePipe,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for await (const batch of pipe.read(context(config))) {
    records.push(...batch.records);
  }
  return records;
}

/** Responds with `body` for every request, recording the URLs it saw. */
function stubFetch(
  body: unknown,
  seen?: string[],
): typeof fetch {
  return (async (input: unknown) => {
    seen?.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('MultiHttpSourcePipe', () => {
  it('fetches all endpoints in parallel and tags records', async () => {
    const started: string[] = [];
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      started.push(url);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const id = url.includes('users') ? 'users' : 'orders';
      return new Response(
        JSON.stringify([{ id, value: id === 'users' ? 1 : 2 }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const batches: Record<string, unknown>[] = [];
    for await (const batch of pipe.read(
      context({
        endpoints: [
          { id: 'users', url: 'https://example.test/users' },
          { id: 'orders', url: 'https://example.test/orders' },
        ],
      }),
    )) {
      batches.push(...batch.records);
    }

    expect(started).toHaveLength(2);
    expect(batches).toEqual(
      expect.arrayContaining([
        { id: 'users', value: 1, _endpoint: 'users' },
        { id: 'orders', value: 2, _endpoint: 'orders' },
      ]),
    );
    expect(batches).toHaveLength(2);
  });

  it('fails the pipe when one endpoint errors and onError is fail', async () => {
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      if (url.includes('bad')) {
        return new Response('nope', { status: 500 });
      }
      return new Response(JSON.stringify([{ ok: true }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(async () => {
      for await (const _ of pipe.read(
        context({
          endpoints: [
            { id: 'ok', url: 'https://example.test/ok' },
            { id: 'bad', url: 'https://example.test/bad' },
          ],
        }),
      )) {
        // drain
      }
    }).rejects.toThrow(/bad/);
  });

  it('skips failed endpoints when onError is skip', async () => {
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      if (url.includes('bad')) {
        return new Response('nope', { status: 500 });
      }
      return new Response(JSON.stringify([{ ok: true }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const batches: Record<string, unknown>[] = [];
    for await (const batch of pipe.read(
      context({
        onError: 'skip',
        endpoints: [
          { id: 'ok', url: 'https://example.test/ok' },
          { id: 'bad', url: 'https://example.test/bad' },
        ],
      }),
    )) {
      batches.push(...batch.records);
    }

    expect(batches).toEqual([{ ok: true, _endpoint: 'ok' }]);
  });

  it('caps in-flight requests at `concurrency` but still fetches every endpoint', async () => {
    let inFlight = 0;
    let peak = 0;
    const pipe = new MultiHttpSourcePipe((async (input: unknown) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(JSON.stringify([{ url: String(input) }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);

    const records = await collect(pipe, {
      concurrency: 2,
      endpoints: Array.from({ length: 6 }, (_, i) => ({
        id: `e${i}`,
        url: `https://example.test/${i}`,
      })),
    });

    expect(records).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
    // The cap must not serialize everything — 2 workers really ran together.
    expect(peak).toBe(2);
  });

  it('extracts nested rows with recordsPath and honors a custom tagField', async () => {
    const pipe = new MultiHttpSourcePipe(
      stubFetch({ data: { items: [{ id: 1 }, { id: 2 }] } }),
    );
    const records = await collect(pipe, {
      tagField: 'source',
      endpoints: [
        {
          id: 'catalog',
          url: 'https://example.test/catalog',
          recordsPath: 'data.items',
        },
      ],
    });
    expect(records).toEqual([
      { id: 1, source: 'catalog' },
      { id: 2, source: 'catalog' },
    ]);
  });

  it('wraps a single object response as one record', async () => {
    const pipe = new MultiHttpSourcePipe(stubFetch({ id: 7, name: 'solo' }));
    const records = await collect(pipe, {
      endpoints: [{ id: 'one', url: 'https://example.test/one' }],
    });
    expect(records).toEqual([{ id: 7, name: 'solo', _endpoint: 'one' }]);
  });

  it('rejects duplicate endpoint ids — tags would be ambiguous', async () => {
    const pipe = new MultiHttpSourcePipe(stubFetch([{ id: 1 }]));
    await expect(
      collect(pipe, {
        endpoints: [
          { id: 'dup', url: 'https://example.test/a' },
          { id: 'dup', url: 'https://example.test/b' },
        ],
      }),
    ).rejects.toThrow(/unique ids/);
  });

  it('rejects duplicate endpoint ids at validateConfig time', () => {
    const pipe = new MultiHttpSourcePipe();
    expect(() =>
      pipe.validateConfig({
        endpoints: [
          { id: 'dup', url: 'https://example.test/a' },
          { id: 'dup', url: 'https://example.test/b' },
        ],
      }),
    ).toThrow(/unique ids/);
  });

  it('names the offending endpoint when a response is not record-shaped', async () => {
    const scalars = new MultiHttpSourcePipe(stubFetch([1, 2, 3]));
    await expect(
      collect(scalars, {
        endpoints: [{ id: 'nums', url: 'https://example.test/nums' }],
      }),
    ).rejects.toThrow(/"nums" records\[0\] must be a JSON object/);

    const missing = new MultiHttpSourcePipe(stubFetch({ data: {} }));
    await expect(
      collect(missing, {
        endpoints: [
          {
            id: 'empty',
            url: 'https://example.test/empty',
            recordsPath: 'data.items',
          },
        ],
      }),
    ).rejects.toThrow(/"empty" response is empty/);
  });

  it('splits the combined result into batches with a resumable offset cursor', async () => {
    const pipe = new MultiHttpSourcePipe(
      stubFetch(Array.from({ length: 5 }, (_, i) => ({ id: i }))),
    );
    const batches = [];
    for await (const batch of pipe.read(
      context({
        batchSize: 2,
        endpoints: [{ id: 'bulk', url: 'https://example.test/bulk' }],
      }),
    )) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.records.length)).toEqual([2, 2, 1]);
    expect(batches.map((batch) => batch.cursor)).toEqual([
      { offset: 2 },
      { offset: 4 },
      { offset: 5 },
    ]);

    // A resumed run picks up where the cursor left off.
    const resumed = context({
      batchSize: 2,
      endpoints: [{ id: 'bulk', url: 'https://example.test/bulk' }],
    });
    resumed.checkpoint = {
      workflowRunId: 'run',
      pipelineId: 'pipeline',
      pipeId: 'multi',
      partitionId: '0',
      cursor: { offset: 4 },
      updatedAt: new Date().toISOString(),
    };
    const rest = [];
    for await (const batch of pipe.read(resumed)) rest.push(...batch.records);
    expect(rest).toEqual([{ id: 4, _endpoint: 'bulk' }]);
  });

  it('runs endpoints linearly in sequence when executionMode is linear', async () => {
    const events: string[] = [];
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      events.push(`start:${url}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${url}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await collect(pipe, {
      executionMode: 'linear',
      endpoints: [
        { id: 'first', url: 'https://example.test/first' },
        { id: 'second', url: 'https://example.test/second' },
      ],
    });

    expect(events).toEqual([
      'start:https://example.test/first',
      'end:https://example.test/first',
      'start:https://example.test/second',
      'end:https://example.test/second',
    ]);
  });

  it('merges multi-endpoint responses into a single record in merge outputMode', async () => {
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      if (url.includes('users')) {
        return new Response(
          JSON.stringify({ items: [{ id: 1, name: 'Alice' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('orders')) {
        return new Response(
          JSON.stringify({ totalCount: 42, active: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ rate: 1.25 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const records = await collect(pipe, {
      outputMode: 'merge',
      endpoints: [
        { id: 'users', url: 'https://example.test/users', recordsPath: 'items' },
        { id: 'orders', url: 'https://example.test/orders' },
        { id: 'rates', url: 'https://example.test/rates' },
      ],
    });

    expect(records).toEqual([
      {
        users: [{ id: 1, name: 'Alice' }],
        orders: { totalCount: 42, active: true },
        rates: { rate: 1.25 },
      },
    ]);
  });

  it('captures failed endpoint error in merged record when onError is skip', async () => {
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      if (url.includes('failing')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({ live: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const records = await collect(pipe, {
      outputMode: 'merge',
      onError: 'skip',
      endpoints: [
        { id: 'good', url: 'https://example.test/good' },
        { id: 'bad', url: 'https://example.test/failing' },
      ],
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.good).toEqual({ live: true });
    expect(records[0]?.bad).toMatchObject({
      ok: false,
      error: expect.stringContaining('500'),
    });
  });

  it('fails pipe when onError is fail in merge outputMode', async () => {
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      if (url.includes('fail')) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(
      collect(pipe, {
        outputMode: 'merge',
        onError: 'fail',
        endpoints: [
          { id: 'good', url: 'https://example.test/good' },
          { id: 'bad', url: 'https://example.test/fail' },
        ],
      }),
    ).rejects.toThrow(/HTTP multi endpoint "bad"/);
  });

  it('keys the merged record in endpoint order, whatever order responses arrive in', async () => {
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      // The first endpoint answers last.
      if (url.includes('slow')) await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ from: url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const [record] = await collect(pipe, {
      outputMode: 'merge',
      endpoints: [
        { id: 'slow', url: 'https://example.test/slow' },
        { id: '__proto__', url: 'https://example.test/fast' },
      ],
    });

    expect(Object.keys(record!)).toEqual(['slow', '__proto__']);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(record))).toEqual({
      slow: { from: 'https://example.test/slow' },
      ['__proto__']: { from: 'https://example.test/fast' },
    });
  });

  it('fails when a recordsPath matches nothing in merge outputMode', async () => {
    const pipe = new MultiHttpSourcePipe(stubFetch({ data: { items: [] } }));

    await expect(
      collect(pipe, {
        outputMode: 'merge',
        endpoints: [{ id: 'orders', url: 'https://example.test/orders', recordsPath: 'data.itmes' }],
      }),
    ).rejects.toThrow(/"orders" recordsPath "data.itmes" matched nothing/);

    const [record] = await collect(pipe, {
      outputMode: 'merge',
      onError: 'skip',
      endpoints: [{ id: 'orders', url: 'https://example.test/orders', recordsPath: 'data.itmes' }],
    });
    expect(record?.orders).toMatchObject({ ok: false, error: expect.stringMatching(/matched nothing/) });
  });

  it('does not deliver the merged record again when resuming past it', async () => {
    let calls = 0;
    const pipe = new MultiHttpSourcePipe(async () => {
      calls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const resumed: PipeContext = {
      ...context({ outputMode: 'merge', endpoints: [{ id: 'a', url: 'https://example.test/a' }] }),
      checkpoint: {
        workflowRunId: 'run',
        pipelineId: 'pipeline',
        pipeId: 'multi',
        partitionId: '0',
        cursor: { offset: 1 },
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
    };

    const batches = [];
    for await (const batch of pipe.read(resumed)) batches.push(batch);

    expect(batches).toEqual([]);
    expect(calls).toBe(0);
  });

  it('pipes merged HTTP output into ScriptTransformPipe for transformation', async () => {
    const sourcePipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      if (url.includes('users')) {
        return new Response(
          JSON.stringify([{ id: 101, name: 'Alice' }, { id: 102, name: 'Bob' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ '101': 3, '102': 7 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const sourceRecords = await collect(sourcePipe, {
      outputMode: 'merge',
      endpoints: [
        { id: 'users', url: 'https://example.test/users' },
        { id: 'orderCounts', url: 'https://example.test/orders' },
      ],
    });

    // Feed the merged payload directly into ScriptTransformPipe
    const scriptPipe = new ScriptTransformPipe();
    const scriptContext: PipeContext = {
      workflowRunId: 'run-1',
      pipelineId: 'pipeline-1',
      pipe: {
        id: 'script-transform',
        role: 'transform',
        type: 'transform.script',
        concurrency: 1,
        config: {
          script: `
            const { users, orderCounts } = records[0];
            return users.map(u => ({
              userId: u.id,
              userName: u.name,
              orders: orderCounts[String(u.id)] || 0
            }));
          `,
        },
      },
    };

    const outputPorts = await scriptPipe.transform(
      {
        id: 'batch-1',
        partitionId: '0',
        records: sourceRecords,
      },
      scriptContext,
    );

    expect(outputPorts.get('out')?.records).toEqual([
      { userId: 101, userName: 'Alice', orders: 3 },
      { userId: 102, userName: 'Bob', orders: 7 },
    ]);
  });

  it('advertises HTTP Multi in the primary palette under Source/API', () => {
    const meta = new MultiHttpSourcePipe().metadata();
    expect(meta.name).toBe('HTTP Multi');
    expect(meta.category).toBe('Source/API');
    expect(meta.palette).toBe('primary');
  });

  it('stops immediately in linear mode with onError: fail and never calls subsequent endpoints', async () => {
    const called: string[] = [];
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      called.push(url);
      if (url.endsWith('/second')) {
        return new Response('boom', { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(
      collect(pipe, {
        executionMode: 'linear',
        onError: 'fail',
        endpoints: [
          { id: 'first', url: 'https://example.test/first' },
          { id: 'second', url: 'https://example.test/second' },
          { id: 'third', url: 'https://example.test/third' },
        ],
      }),
    ).rejects.toThrow(/second.*500/i);

    expect(called).toEqual(['https://example.test/first', 'https://example.test/second']);
  });

  it('continues in exact order in linear mode with onError: skip and merge outputMode', async () => {
    const order: string[] = [];
    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      order.push(url);
      if (url.endsWith('/second')) {
        return new Response('missing', { status: 404 });
      }
      return new Response(JSON.stringify({ source: url.split('/').pop() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const [merged] = await collect(pipe, {
      executionMode: 'linear',
      outputMode: 'merge',
      onError: 'skip',
      endpoints: [
        { id: 'first', url: 'https://example.test/first' },
        { id: 'second', url: 'https://example.test/second' },
        { id: 'third', url: 'https://example.test/third' },
      ],
    });

    expect(order).toEqual([
      'https://example.test/first',
      'https://example.test/second',
      'https://example.test/third',
    ]);
    expect(Object.keys(merged ?? {})).toEqual(['first', 'second', 'third']);
    expect(merged?.first).toEqual({ source: 'first' });
    expect(merged?.second).toMatchObject({ ok: false, error: expect.stringMatching(/404/) });
    expect(merged?.third).toEqual({ source: 'third' });
  });

  it('prevents sibling parallel workers from starting queued endpoints after an onError: fail abort', async () => {
    const started: string[] = [];
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const pipe = new MultiHttpSourcePipe(async (input) => {
      const url = String(input);
      started.push(url);
      if (url.endsWith('/ep1')) {
        return new Response('bad gateway', { status: 502 });
      }
      if (url.endsWith('/ep2')) {
        await secondGate;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const run = collect(pipe, {
      executionMode: 'parallel',
      concurrency: 2,
      onError: 'fail',
      endpoints: [
        { id: 'ep1', url: 'https://example.test/ep1' },
        { id: 'ep2', url: 'https://example.test/ep2' },
        { id: 'ep3', url: 'https://example.test/ep3' },
        { id: 'ep4', url: 'https://example.test/ep4' },
      ],
    });

    await expect(run).rejects.toThrow(/ep1.*502/i);
    releaseSecond();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(['https://example.test/ep1', 'https://example.test/ep2']);
  });

  it('handles all-endpoints-failing gracefully under onError: skip in both records and merge modes', async () => {
    const failingFetch: typeof fetch = async () => new Response('down', { status: 503 });
    const pipe = new MultiHttpSourcePipe(failingFetch);

    const recordsOut = await collect(pipe, {
      executionMode: 'parallel',
      outputMode: 'records',
      onError: 'skip',
      endpoints: [
        { id: 'a', url: 'https://example.test/a' },
        { id: 'b', url: 'https://example.test/b' },
      ],
    });
    expect(recordsOut).toEqual([]);

    const [mergedOut] = await collect(pipe, {
      executionMode: 'parallel',
      outputMode: 'merge',
      onError: 'skip',
      endpoints: [
        { id: 'a', url: 'https://example.test/a' },
        { id: 'b', url: 'https://example.test/b' },
      ],
    });
    expect(mergedOut).toMatchObject({
      a: { ok: false, error: expect.stringMatching(/503/) },
      b: { ok: false, error: expect.stringMatching(/503/) },
    });
  });

  it('handles empty arrays, 204/null responses, and non-object array elements cleanly', async () => {
    const emptyArrPipe = new MultiHttpSourcePipe(stubFetch([]));
    expect(
      await collect(emptyArrPipe, {
        outputMode: 'records',
        endpoints: [{ id: 'empty', url: 'https://example.test/empty' }],
      }),
    ).toEqual([]);

    const nullPipe = new MultiHttpSourcePipe(stubFetch(null));
    await expect(
      collect(nullPipe, {
        outputMode: 'records',
        onError: 'fail',
        endpoints: [{ id: 'nil', url: 'https://example.test/nil' }],
      }),
    ).rejects.toThrow(/response is empty/i);
    expect(
      await collect(nullPipe, {
        outputMode: 'records',
        onError: 'skip',
        endpoints: [{ id: 'nil', url: 'https://example.test/nil' }],
      }),
    ).toEqual([]);

    const primitiveArrayPipe = new MultiHttpSourcePipe(stubFetch([1, 2, 3]));
    await expect(
      collect(primitiveArrayPipe, {
        outputMode: 'records',
        onError: 'fail',
        endpoints: [{ id: 'nums', url: 'https://example.test/nums' }],
      }),
    ).rejects.toThrow(/must be a JSON object/i);
  });

  it('enforces parallel concurrency cap while preserving endpoint result order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pipe = new MultiHttpSourcePipe(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const id = String(input).split('/').pop()!;
      // Earlier endpoints finish slower to prove output order still matches config order.
      const delayMs = id === 'e1' ? 25 : id === 'e2' ? 15 : 5;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const rows = await collect(pipe, {
      executionMode: 'parallel',
      concurrency: 2,
      endpoints: [
        { id: 'e1', url: 'https://example.test/e1' },
        { id: 'e2', url: 'https://example.test/e2' },
        { id: 'e3', url: 'https://example.test/e3' },
        { id: 'e4', url: 'https://example.test/e4' },
        { id: 'e5', url: 'https://example.test/e5' },
      ],
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(rows.map((r) => r._endpoint)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });
});
