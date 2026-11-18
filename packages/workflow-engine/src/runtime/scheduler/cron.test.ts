/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/runtime/src/scheduler/cron.test.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSqliteStores } from '../../storage/index.js';
import type { TriggerInvocation } from '../../common/index.js';
import { CronCoordinator } from './cron.js';

function fingerprint(trigger: {
  cron: string;
  timezone: string;
  executionType: string;
  http?: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cron: trigger.cron,
        timezone: trigger.timezone,
        executionType: trigger.executionType,
        http: trigger.http ?? null,
      }),
    )
    .digest('hex');
}

describe('CronCoordinator', () => {
  it('accepts one missed occurrence and does not fire it twice', async () => {
    const stores = openSqliteStores(':memory:', randomBytes(32));
    const cronTrigger = {
      id: 'every-minute',
      kind: 'cron' as const,
      enabled: true,
      cron: '* * * * *',
      timezone: 'UTC',
      catchUp: 'one' as const,
      executionType: 'workflow' as const,
    };
    await stores.workflows.put({
      id: 'scheduled',
      name: 'scheduled',
      version: 1,
      pipelines: [
        {
          id: 'load',
          name: 'load',
          pipes: [
            {
              id: 'source',
              role: 'source',
              type: 'source.triggerPayload',
              config: {},
              concurrency: 1,
            },
          ],
          edges: [],
        },
      ],
      dependencies: [],
      middleware: [],
      triggers: [cronTrigger],
      onOverlap: 'parallel',
      origin: 'authored',
    });
    await stores.schedules.put({
      workflowId: 'scheduled',
      triggerId: 'every-minute',
      nextFireAt: '2026-07-14T10:04:00.000Z',
      scheduleFingerprint: fingerprint(cronTrigger),
    });
    const invocations: unknown[] = [];
    const coordinator = new CronCoordinator({
      workflows: stores.workflows,
      schedules: stores.schedules,
      scheduler: {
        async enqueue(_workflow, invocation) {
          invocations.push(invocation);
        },
      },
      now: () => new Date('2026-07-14T10:05:30.000Z'),
    });

    await coordinator.recover();
    await coordinator.recover();

    expect(invocations).toEqual([
      expect.objectContaining({
        workflowId: 'scheduled',
        triggerId: 'every-minute',
        kind: 'cron',
        idempotencyKey: 'cron:2026-07-14T10:04:00.000Z',
        payload: { scheduledAt: '2026-07-14T10:04:00.000Z' },
      }),
    ]);
    expect(await stores.schedules.get('scheduled', 'every-minute')).toMatchObject({
      workflowId: 'scheduled',
      triggerId: 'every-minute',
      nextFireAt: '2026-07-14T10:06:00.000Z',
      lastAcceptedAt: '2026-07-14T10:04:00.000Z',
      scheduleFingerprint: expect.any(String),
    });

    const workflow = await stores.workflows.get('scheduled');
    if (!workflow) throw new Error('test workflow missing');
    await stores.workflows.put({
      ...workflow,
      triggers: workflow.triggers.map((trigger) =>
        trigger.kind === 'cron' ? { ...trigger, cron: '0 * * * *' } : trigger,
      ),
    });
    await coordinator.recover();
    expect(await stores.schedules.get('scheduled', 'every-minute')).toMatchObject({
      nextFireAt: '2026-07-14T11:00:00.000Z',
      lastAcceptedAt: undefined,
    });
    expect(invocations).toHaveLength(1);

    await stores.schedules.put({
      workflowId: 'scheduled',
      triggerId: 'every-minute',
      nextFireAt: '2026-07-14T10:04:00.000Z',
    });
    await coordinator.recover();
    expect(await stores.schedules.get('scheduled', 'every-minute')).toMatchObject({
      nextFireAt: '2026-07-14T11:00:00.000Z',
      lastAcceptedAt: undefined,
      scheduleFingerprint: expect.any(String),
    });
    expect(invocations).toHaveLength(1);
    stores.close();
  });

  it('fires executionType http with the shared request config (no workflow enqueue)', async () => {
    const stores = openSqliteStores(':memory:', randomBytes(32));
    const http = {
      url: 'https://hooks.example.com/tick',
      method: 'POST' as const,
      query: [{ key: 'source', value: 'cron', enabled: true }],
      headers: [{ key: 'x-test', value: '1', enabled: true }],
      auth: { type: 'none' as const },
      body: { mode: 'json' as const, json: { ping: true } },
      timeoutMs: 5_000,
      variables: {},
      session: { enabled: false, persistToCredential: true },
    };
    const cronTrigger = {
      id: 'http-job',
      kind: 'cron' as const,
      enabled: true,
      cron: '* * * * *',
      timezone: 'UTC',
      catchUp: 'one' as const,
      executionType: 'http' as const,
      http,
    };
    await stores.workflows.put({
      id: 'http-scheduled',
      name: 'http-scheduled',
      version: 1,
      pipelines: [
        {
          id: 'noop',
          name: 'noop',
          pipes: [
            {
              id: 'source',
              role: 'source',
              type: 'source.triggerPayload',
              config: {},
              concurrency: 1,
            },
          ],
          edges: [],
        },
      ],
      dependencies: [],
      middleware: [],
      triggers: [cronTrigger],
      onOverlap: 'skip',
      origin: 'authored',
    });
    await stores.schedules.put({
      workflowId: 'http-scheduled',
      triggerId: 'http-job',
      nextFireAt: '2026-07-14T10:04:00.000Z',
      scheduleFingerprint: fingerprint(cronTrigger),
    });

    const enqueued: unknown[] = [];
    const fetches: string[] = [];
    const coordinator = new CronCoordinator({
      workflows: stores.workflows,
      schedules: stores.schedules,
      scheduler: {
        async enqueue(_workflow, invocation) {
          enqueued.push(invocation);
        },
      },
      fetch: async (url) => {
        fetches.push(String(url));
        return new Response('ok', { status: 200 });
      },
      now: () => new Date('2026-07-14T10:05:30.000Z'),
    });

    await coordinator.recover();
    // HTTP fires are detached from the scheduling tick — drain the microtask
    // chain before asserting the call happened.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(enqueued).toHaveLength(0);
    expect(fetches).toEqual([
      'https://hooks.example.com/tick?source=cron',
    ]);
    stores.close();
  });

  describe('executionType sql', () => {
    const NOW = new Date('2026-07-14T10:05:30.000Z');
    const DUE = '2026-07-14T10:05:00.000Z';

    async function setup(
      sqlOverrides: Record<string, unknown> = {},
      options: { credentialKind?: 'database' | 'http'; retry?: boolean } = {},
    ) {
      const stores = openSqliteStores(':memory:', randomBytes(32));
      const credential = await stores.credentials.create({
        name: 'warehouse',
        kind: options.credentialKind ?? 'database',
        data: { dialect: 'postgres', host: 'db.internal', password: 'pw' },
      });
      const cronTrigger = {
        id: 'watch',
        kind: 'cron' as const,
        enabled: true,
        cron: '* * * * *',
        timezone: 'UTC',
        catchUp: 'one' as const,
        executionType: 'sql' as const,
        sql: {
          credentialId: credential.id,
          script: 'SELECT id, sku FROM orders WHERE shipped = false',
          onlyWhenRows: true,
          transaction: false,
          maxRows: 1000,
          ...sqlOverrides,
        },
        ...(options.retry
          ? {
              retryConfig: {
                maxRetryAttempts: 1,
                maxRetryDuration: '0s',
                minBackoffDuration: '0s',
                maxBackoffDuration: '0s',
                maxDoublings: 0,
              },
            }
          : {}),
      };
      await stores.workflows.put({
        id: 'sql-scheduled',
        name: 'sql-scheduled',
        version: 1,
        pipelines: [
          {
            id: 'load',
            name: 'load',
            pipes: [
              {
                id: 'source',
                role: 'source',
                type: 'source.trigger.cron',
                config: {},
                concurrency: 1,
              },
            ],
            edges: [],
          },
        ],
        dependencies: [],
        middleware: [],
        triggers: [cronTrigger],
        onOverlap: 'skip',
        origin: 'authored',
      });
      await stores.schedules.put({
        workflowId: 'sql-scheduled',
        triggerId: 'watch',
        nextFireAt: DUE,
        scheduleFingerprint: createHash('sha256')
          .update(
            JSON.stringify({
              cron: cronTrigger.cron,
              timezone: cronTrigger.timezone,
              executionType: cronTrigger.executionType,
              http: null,
              sql: cronTrigger.sql,
            }),
          )
          .digest('hex'),
      });
      return { stores, credentialId: credential.id };
    }

    function coordinatorFor(
      stores: ReturnType<typeof openSqliteStores>,
      runSql: ConstructorParameters<typeof CronCoordinator>[0]['runSql'],
    ) {
      const enqueued: TriggerInvocation[] = [];
      const errors: unknown[] = [];
      const coordinator = new CronCoordinator({
        workflows: stores.workflows,
        schedules: stores.schedules,
        credentials: stores.credentials,
        scheduler: {
          async enqueue(_workflow, invocation) {
            enqueued.push(invocation);
          },
        },
        runSql,
        onError: (error) => errors.push(error),
        now: () => NOW,
      });
      return { coordinator, enqueued, errors };
    }

    /** SQL fires are detached from the tick; let them settle. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    it('runs the script against the credential and starts the workflow with the rows', async () => {
      const { stores } = await setup();
      const calls: { connection: unknown; script: string; transaction: boolean }[] = [];
      const { coordinator, enqueued, errors } = coordinatorFor(stores, async (connection, script, options) => {
        calls.push({ connection, script, transaction: options.transaction });
        return [
          { id: 1, sku: 'A-1' },
          { id: 2, sku: 'B-2' },
        ];
      });

      await coordinator.tick();
      await settle();

      expect(errors).toEqual([]);
      expect(calls).toEqual([
        {
          // An engine-entered credential is the option bag; its dialect says
          // which driver to use.
          connection: { dialect: 'postgres', option: { host: 'db.internal', password: 'pw' } },
          script: 'SELECT id, sku FROM orders WHERE shipped = false',
          transaction: false,
        },
      ]);
      expect(enqueued).toEqual([
        expect.objectContaining({
          kind: 'cron',
          idempotencyKey: `cron:${DUE}`,
          payload: {
            scheduledAt: DUE,
            rowCount: 2,
            rows: [
              { id: 1, sku: 'A-1' },
              { id: 2, sku: 'B-2' },
            ],
          },
        }),
      ]);
      stores.close();
    });

    it('creates no run when the script returns nothing and onlyWhenRows is on', async () => {
      const { stores } = await setup();
      const { coordinator, enqueued, errors } = coordinatorFor(stores, async () => []);

      await coordinator.tick();
      await settle();

      expect(errors).toEqual([]);
      expect(enqueued).toEqual([]);
      // The schedule still advances: an empty tick is a normal tick.
      expect((await stores.schedules.get('sql-scheduled', 'watch'))?.nextFireAt).toBe(
        '2026-07-14T10:06:00.000Z',
      );
      stores.close();
    });

    it('starts a run with no rows when onlyWhenRows is off', async () => {
      const { stores } = await setup({ onlyWhenRows: false });
      const { coordinator, enqueued } = coordinatorFor(stores, async () => []);

      await coordinator.tick();
      await settle();

      expect(enqueued).toEqual([
        expect.objectContaining({ payload: { scheduledAt: DUE, rowCount: 0, rows: [] } }),
      ]);
      stores.close();
    });

    it('caps the rows carried into the run and says so', async () => {
      const { stores } = await setup({ maxRows: 2 });
      const { coordinator, enqueued } = coordinatorFor(stores, async () => [
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]);

      await coordinator.tick();
      await settle();

      expect(enqueued[0]?.payload).toEqual({
        scheduledAt: DUE,
        rowCount: 3,
        truncated: true,
        rows: [{ id: 1 }, { id: 2 }],
      });
      stores.close();
    });

    it('refuses a credential that is not a database credential', async () => {
      const { stores } = await setup({}, { credentialKind: 'http' });
      let ran = false;
      const { coordinator, enqueued, errors } = coordinatorFor(stores, async () => {
        ran = true;
        return [{ id: 1 }];
      });

      await coordinator.tick();
      await settle();

      expect(ran).toBe(false);
      expect(enqueued).toEqual([]);
      expect(String(errors[0])).toMatch(/is not a database credential/);
      stores.close();
    });

    it('reports a failing script instead of starting a run, and retries when configured', async () => {
      const { stores } = await setup({}, { retry: true });
      let attempts = 0;
      const { coordinator, enqueued, errors } = coordinatorFor(stores, async () => {
        attempts += 1;
        throw new Error('relation "orders" does not exist');
      });

      await coordinator.tick();
      await settle();

      expect(attempts).toBe(2);
      expect(enqueued).toEqual([]);
      expect(String(errors[0])).toMatch(/relation "orders" does not exist/);
      stores.close();
    });

    it('skips a fire while the previous run of the script is still going', async () => {
      const { stores } = await setup();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const { coordinator, enqueued, errors } = coordinatorFor(stores, async () => {
        calls += 1;
        await blocked;
        return [{ id: 1 }];
      });

      await coordinator.tick();
      // Make the next occurrence due while the first script still runs.
      await stores.schedules.put({
        ...(await stores.schedules.get('sql-scheduled', 'watch'))!,
        nextFireAt: DUE,
      });
      await coordinator.tick();
      release();
      await settle();

      expect(calls).toBe(1);
      expect(enqueued).toHaveLength(1);
      expect(String(errors[0])).toMatch(/skipped: the previous run of its script has not finished/);
      stores.close();
    });
  });
});
