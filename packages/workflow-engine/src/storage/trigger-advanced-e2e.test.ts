/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/storage/src/trigger-advanced-e2e.test.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CronCoordinator,
  Engine,
  parseWorkflow,
  type TriggerInvocation,
  type WorkflowDef,
} from '../index.js';

/**
 * Trigger behavior under pressure: two fires racing the same workflow
 * (overlap policy), a scheduler that was down across several cron windows
 * (catch-up), a webhook client that retries (idempotent replay), and
 * workflows whose several triggers each feed their own source pipe.
 *
 * These are the cases that only show up in production, so they are pinned
 * here rather than left to the happy-path trigger suite.
 */

function engineFor(): Engine {
  return new Engine({
    databasePath: ':memory:',
    encryptionKey: randomBytes(32),
    instanceId: 'trigger-advanced',
  });
}

/** Cron fingerprint must match the coordinator's, else it rebases instead of firing. */
function fingerprintOf(trigger: {
  cron: string;
  timezone: string;
  executionType: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cron: trigger.cron,
        timezone: trigger.timezone,
        executionType: trigger.executionType,
        http: null,
      }),
    )
    .digest('hex');
}

/**
 * Webhook/HTTP triggers require a credential id at parse time. These tests
 * enqueue invocations directly, past the ingress routes that would reveal and
 * verify the secret, so a placeholder id is enough here — signature checking
 * has its own coverage in `apps/api/src/triggers.test.ts`.
 */
const CRED = 'cred-placeholder';

const CRON_TRIGGER = {
  id: 'nightly',
  kind: 'cron' as const,
  enabled: true,
  cron: '0 * * * *', // hourly, so missed windows accumulate fast
  timezone: 'UTC',
  executionType: 'workflow' as const,
};

/** One-pipe workflow whose source is `sourceType`. */
function workflowWith(
  id: string,
  triggers: unknown[],
  sourceType = 'source.triggerPayload',
  extra: Record<string, unknown> = {},
): WorkflowDef {
  return parseWorkflow({
    id,
    name: id,
    triggers,
    ...extra,
    pipelines: [
      {
        id: 'main',
        name: 'main',
        pipes: [{ id: 'src', role: 'source', type: sourceType, config: {} }],
        edges: [],
      },
    ],
  });
}

function invocation(
  workflow: WorkflowDef,
  triggerId: string,
  kind: TriggerInvocation['kind'],
  extra: Partial<TriggerInvocation> = {},
): TriggerInvocation {
  return {
    id: `inv-${triggerId}-${Math.random().toString(16).slice(2)}`,
    workflowId: workflow.id,
    triggerId,
    kind,
    acceptedAt: new Date().toISOString(),
    metadata: {},
    ...extra,
  };
}

describe('overlap policy under concurrent trigger fires', () => {
  it('skips a second fire while the first run is still in flight', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'overlap-skip',
      [{ id: 'hook', kind: 'webhook', enabled: true, credentialId: CRED }],
      'source.triggerPayload',
      { onOverlap: 'skip' },
    );
    await engine.stores.workflows.put(workflow);

    // Fire twice without awaiting idle: the second meets an active run.
    const first = await engine.scheduler.enqueue(
      workflow,
      invocation(workflow, 'hook', 'webhook', { payload: { n: 1 } }),
    );
    const second = await engine.scheduler.enqueue(
      workflow,
      invocation(workflow, 'hook', 'webhook', { payload: { n: 2 } }),
    );
    await engine.idle();

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('overlap');
    // The rejected fire points at the run that blocked it, not a new one.
    expect(second.run!.id).toBe(first.run!.id);
    expect(await engine.stores.runs.list('overlap-skip')).toHaveLength(1);
    engine.close();
  });

  it('queues overlapping fires and runs them one at a time, in order', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'overlap-queue',
      [{ id: 'hook', kind: 'webhook', enabled: true, credentialId: CRED }],
      'source.triggerPayload',
      { onOverlap: 'queue' },
    );
    await engine.stores.workflows.put(workflow);

    const fires = await Promise.all(
      [1, 2, 3].map((n) =>
        engine.scheduler.enqueue(
          workflow,
          invocation(workflow, 'hook', 'webhook', { payload: { n } }),
        ),
      ),
    );
    await engine.idle();

    expect(fires.every((fire) => fire.accepted)).toBe(true);
    const runs = await engine.stores.runs.list('overlap-queue');
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true);
    engine.close();
  });

  it('admits overlapping fires immediately when the policy is parallel', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'overlap-parallel',
      [{ id: 'hook', kind: 'webhook', enabled: true, credentialId: CRED }],
      'source.triggerPayload',
      { onOverlap: 'parallel' },
    );
    await engine.stores.workflows.put(workflow);

    const fires = await Promise.all(
      [1, 2, 3].map((n) =>
        engine.scheduler.enqueue(
          workflow,
          invocation(workflow, 'hook', 'webhook', { payload: { n } }),
        ),
      ),
    );
    await engine.idle();

    expect(fires.every((fire) => fire.accepted)).toBe(true);
    const runs = await engine.stores.runs.list('overlap-parallel');
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true);
    engine.close();
  });
});

describe('webhook replay and idempotency', () => {
  it('collapses a retried delivery onto the original run', async () => {
    const engine = engineFor();
    const workflow = workflowWith('replay', [
      { id: 'hook', kind: 'webhook', enabled: true, credentialId: CRED },
    ]);
    await engine.stores.workflows.put(workflow);

    const delivery = invocation(workflow, 'hook', 'webhook', {
      payload: { order: 1 },
      idempotencyKey: 'delivery-abc',
    });
    const first = await engine.scheduler.enqueue(workflow, delivery);
    await engine.idle();
    // The client retries the exact same delivery after our 202 was lost.
    const retry = await engine.scheduler.enqueue(workflow, {
      ...delivery,
      id: 'inv-retry',
    });
    await engine.idle();

    expect(retry.reason).toBe('duplicate');
    expect(retry.run!.id).toBe(first.run!.id);
    expect(await engine.stores.runs.list('replay')).toHaveLength(1);
    engine.close();
  });

  it('treats a different idempotency key as genuinely new work', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'replay-distinct',
      [{ id: 'hook', kind: 'webhook', enabled: true, credentialId: CRED }],
      'source.triggerPayload',
      { onOverlap: 'queue' },
    );
    await engine.stores.workflows.put(workflow);

    for (const key of ['delivery-1', 'delivery-2']) {
      await engine.scheduler.enqueue(
        workflow,
        invocation(workflow, 'hook', 'webhook', {
          payload: { key },
          idempotencyKey: key,
        }),
      );
    }
    await engine.idle();

    expect(await engine.stores.runs.list('replay-distinct')).toHaveLength(2);
    engine.close();
  });
});

describe('cron catch-up after downtime', () => {
  /** Seed a schedule whose nextFireAt is `hoursAgo` behind `now`. */
  async function seedSchedule(
    engine: Engine,
    workflow: WorkflowDef,
    catchUp: 'one' | 'all' | 'none',
    nextFireAt: string,
  ): Promise<void> {
    await engine.stores.workflows.put(workflow);
    await engine.stores.schedules.put({
      workflowId: workflow.id,
      triggerId: 'nightly',
      nextFireAt,
      scheduleFingerprint: fingerprintOf(CRON_TRIGGER),
    });
    void catchUp;
  }

  function cronWorkflow(
    id: string,
    catchUp: 'one' | 'all' | 'none',
    onOverlap: 'skip' | 'queue' | 'parallel' = 'skip',
  ) {
    return workflowWith(
      id,
      [{ ...CRON_TRIGGER, catchUp }],
      'source.trigger.cron',
      { onOverlap },
    );
  }

  /** Coordinator pinned to a fixed "now", four hours past the seeded window. */
  function coordinatorAt(engine: Engine, iso: string): CronCoordinator {
    return new CronCoordinator({
      workflows: engine.stores.workflows,
      schedules: engine.stores.schedules,
      scheduler: engine.scheduler,
      now: () => new Date(iso),
    });
  }

  it('fires every missed window when catchUp is "all"', async () => {
    const engine = engineFor();
    // `queue` is required to actually observe the backlog — see the overlap
    // interaction test below, which is the trap here.
    const workflow = cronWorkflow('catchup-all', 'all', 'queue');
    await seedSchedule(engine, workflow, 'all', '2026-07-20T00:00:00.000Z');

    // Scheduler was down 00:00 → 04:30, so five windows are due: the seeded
    // 00:00 itself plus 01:00…04:00.
    await coordinatorAt(engine, '2026-07-20T04:30:00.000Z').recover();
    await engine.idle();

    const runs = await engine.stores.runs.list('catchup-all');
    expect(runs).toHaveLength(5);
    expect(runs.every((run) => run.trigger === 'cron')).toBe(true);
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true);
    // The schedule advances one step past the last window it fired (04:00),
    // NOT past `now` — so a still-missed window is not silently dropped.
    const state = await engine.stores.schedules.get('catchup-all', 'nightly');
    expect(state?.nextFireAt).toBe('2026-07-20T05:00:00.000Z');
    engine.close();
  });

  it('collapses a catch-up backlog when the overlap policy is "skip"', async () => {
    const engine = engineFor();
    // catchUp:'all' asks for four fires, but the default overlap policy
    // rejects each one that meets an in-flight run — so a workflow that is
    // not safe to run concurrently silently gets ONE catch-up run, not four.
    // Anyone relying on catchUp:'all' must also choose queue/parallel.
    const workflow = cronWorkflow('catchup-clash', 'all', 'skip');
    await seedSchedule(engine, workflow, 'all', '2026-07-20T00:00:00.000Z');

    await coordinatorAt(engine, '2026-07-20T04:30:00.000Z').recover();
    await engine.idle();

    expect(await engine.stores.runs.list('catchup-clash')).toHaveLength(1);
    // The schedule advances as though all five had fired — the skipped fires
    // are gone for good, not retried on the next tick.
    const state = await engine.stores.schedules.get('catchup-clash', 'nightly');
    expect(state?.nextFireAt).toBe('2026-07-20T05:00:00.000Z');
    engine.close();
  });

  it('collapses missed windows into a single run when catchUp is "one"', async () => {
    const engine = engineFor();
    const workflow = cronWorkflow('catchup-one', 'one');
    await seedSchedule(engine, workflow, 'one', '2026-07-20T00:00:00.000Z');

    await coordinatorAt(engine, '2026-07-20T04:30:00.000Z').recover();
    await engine.idle();

    expect(await engine.stores.runs.list('catchup-one')).toHaveLength(1);
    // Next fire is relative to now, not to the backlog.
    const state = await engine.stores.schedules.get('catchup-one', 'nightly');
    expect(state?.nextFireAt).toBe('2026-07-20T05:00:00.000Z');
    engine.close();
  });

  it('skips the backlog entirely on recovery when catchUp is "none"', async () => {
    const engine = engineFor();
    const workflow = cronWorkflow('catchup-none', 'none');
    await seedSchedule(engine, workflow, 'none', '2026-07-20T00:00:00.000Z');

    await coordinatorAt(engine, '2026-07-20T04:30:00.000Z').recover();
    await engine.idle();

    expect(await engine.stores.runs.list('catchup-none')).toEqual([]);
    // But the schedule is re-based so the next live window still fires.
    const state = await engine.stores.schedules.get('catchup-none', 'nightly');
    expect(state?.nextFireAt).toBe('2026-07-20T05:00:00.000Z');
    engine.close();
  });

  it('rebases instead of firing when the schedule was edited', async () => {
    const engine = engineFor();
    const workflow = cronWorkflow('rebased', 'all');
    await engine.stores.workflows.put(workflow);
    // A stale fingerprint means the cron expression changed since this row.
    await engine.stores.schedules.put({
      workflowId: 'rebased',
      triggerId: 'nightly',
      nextFireAt: '2026-07-20T00:00:00.000Z',
      scheduleFingerprint: 'stale-fingerprint',
    });

    await coordinatorAt(engine, '2026-07-20T04:30:00.000Z').recover();
    await engine.idle();

    // No catch-up storm from an old schedule the user already replaced.
    expect(await engine.stores.runs.list('rebased')).toEqual([]);
    const state = await engine.stores.schedules.get('rebased', 'nightly');
    expect(state?.scheduleFingerprint).toBe(fingerprintOf(CRON_TRIGGER));
    expect(state?.nextFireAt).toBe('2026-07-20T05:00:00.000Z');
    engine.close();
  });

  it('drops the schedule row once its trigger is disabled', async () => {
    const engine = engineFor();
    const workflow = cronWorkflow('retired', 'one');
    await seedSchedule(engine, workflow, 'one', '2026-07-20T00:00:00.000Z');

    const disabled = workflowWith(
      'retired',
      [{ ...CRON_TRIGGER, catchUp: 'one', enabled: false }],
      'source.trigger.cron',
    );
    await engine.stores.workflows.put(disabled);
    await coordinatorAt(engine, '2026-07-20T04:30:00.000Z').recover();
    await engine.idle();

    expect(await engine.stores.runs.list('retired')).toEqual([]);
    expect(await engine.stores.schedules.get('retired', 'nightly')).toBeUndefined();
    engine.close();
  });
});

describe('workflows with several triggers', () => {
  it('feeds only the pipe bound to the trigger that actually fired', async () => {
    const engine = engineFor();
    // Two source pipes, each bound to its own trigger; one fire must not
    // produce records on the other's pipe.
    const workflow = parseWorkflow({
      id: 'multi-trigger',
      name: 'multi-trigger',
      onOverlap: 'queue',
      origin: 'authored',
      triggers: [
        { id: 'hook', kind: 'webhook', enabled: true, credentialId: CRED },
        { id: 'other', kind: 'webhook', enabled: true, credentialId: CRED },
      ],
      pipelines: [
        {
          id: 'main',
          name: 'main',
          pipes: [
            {
              id: 'from-hook',
              role: 'source',
              type: 'source.trigger.webhook',
              config: { triggerId: 'hook' },
            },
            {
              id: 'from-other',
              role: 'source',
              type: 'source.trigger.webhook',
              config: { triggerId: 'other' },
            },
          ],
          edges: [],
        },
      ],
    });
    await engine.stores.workflows.put(workflow);

    const hook = await engine.scheduler.enqueue(
      workflow,
      invocation(workflow, 'hook', 'webhook', {
        payload: [{ via: 'hook' }, { via: 'hook' }],
      }),
    );
    await engine.idle();

    const pipes = Object.fromEntries(
      (await engine.stores.runs.listPipes(hook.run!.id)).map((pipe) => [
        pipe.pipeId,
        { status: pipe.status, records: pipe.processedRecords },
      ]),
    );
    // The pipe bound to the trigger that fired emitted; the one bound to the
    // other webhook stayed idle rather than inventing records.
    expect(pipes['from-hook']).toEqual({ status: 'success', records: 2 });
    expect(pipes['from-other']?.records ?? 0).toBe(0);
    engine.close();
  });

  it('records which trigger started each run when several can', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'attribution',
      [
        { id: 'hook', kind: 'webhook', enabled: true, credentialId: CRED },
        { id: 'nightly', kind: 'cron', enabled: true, cron: '0 0 * * *' },
        { id: 'evt', kind: 'parent', enabled: true },
      ],
      'source.triggerPayload',
      { onOverlap: 'queue' },
    );
    await engine.stores.workflows.put(workflow);

    for (const [triggerId, kind] of [
      ['hook', 'webhook'],
      ['nightly', 'cron'],
      ['evt', 'parent'],
    ] as const) {
      await engine.scheduler.enqueue(
        workflow,
        invocation(workflow, triggerId, kind, { payload: { from: triggerId } }),
      );
    }
    await engine.idle();

    const runs = await engine.stores.runs.list('attribution');
    expect(runs).toHaveLength(3);
    expect(
      runs.map((run) => `${run.trigger}:${run.triggerId}`).sort(),
    ).toEqual(['cron:nightly', 'parent:evt', 'webhook:hook']);
    engine.close();
  });
});

describe('parent trigger chains', () => {
  it('passes the caller batch to a child and attributes it to the parent run', async () => {
    const engine = engineFor();
    const child = parseWorkflow({
      id: 'child-import',
      name: 'child-import',
      triggers: [{ id: 'parent', kind: 'parent', enabled: true }],
      pipelines: [
        {
          id: 'main',
          name: 'main',
          pipes: [
            { id: 'rows', role: 'source', type: 'source.trigger.parent', config: {} },
          ],
          edges: [],
        },
      ],
    });
    const caller = parseWorkflow({
      id: 'caller',
      name: 'caller',
      triggers: [
        {
          id: 'manual',
          kind: 'manual',
          enabled: true,
          inputData: [{ id: 1 }, { id: 2 }, { id: 3 }],
        },
      ],
      pipelines: [
        {
          id: 'main',
          name: 'main',
          pipes: [
            { id: 'src', role: 'source', type: 'source.trigger.manual', config: {} },
            {
              id: 'call',
              role: 'transform',
              type: 'workflow.sub',
              config: { workflowId: 'child-import' },
            },
          ],
          edges: [{ from: 'src', to: 'call' }],
        },
      ],
    });
    await engine.stores.workflows.put(child);
    await engine.stores.workflows.put(caller);

    const parent = await engine.scheduler.enqueue(caller);
    await engine.idle();

    const childRuns = await engine.stores.runs.list('child-import');
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]!.status).toBe('succeeded');
    // The child knows who called it, and by which trigger kind.
    expect(childRuns[0]!.parentRunId).toBe(parent.run!.id);
    expect(childRuns[0]!.trigger).toBe('parent');

    const childPipes = await engine.stores.runs.listPipes(childRuns[0]!.id);
    expect(childPipes[0]?.processedRecords).toBe(3);
    engine.close();
  });
});
