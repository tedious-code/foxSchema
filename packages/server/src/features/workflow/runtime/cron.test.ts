/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/cron.test.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  openSqliteStores,
  CronCoordinator,
} from '@foxschema/workflow-engine';

describe('CronCoordinator', () => {
  it('accepts one missed occurrence and does not fire it twice', async () => {
    const stores = openSqliteStores(':memory:', randomBytes(32));
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
      triggers: [
        {
          id: 'every-minute',
          kind: 'cron',
          enabled: true,
          cron: '* * * * *',
          timezone: 'UTC',
          catchUp: 'one',
          executionType: 'workflow',
        },
      ],
      onOverlap: 'parallel',
      origin: 'authored',
    });
    await stores.schedules.put({
      workflowId: 'scheduled',
      triggerId: 'every-minute',
      nextFireAt: '2026-07-14T10:04:00.000Z',
      scheduleFingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            cron: '* * * * *',
            timezone: 'UTC',
            executionType: 'workflow',
            http: null,
          }),
        )
        .digest('hex'),
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
});
