/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/storage/src/triggers.test.ts).
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
 * End-to-end coverage for every trigger kind: each one must admit a run,
 * reach the trigger source pipe, and land the invocation payload in the data
 * plane. Ingress-specific rules (auth, allowFrom, required fields) live with
 * their own routes; here we prove the shared activation path works per kind.
 */

function engineFor(): Engine {
  return new Engine({
    databasePath: ':memory:',
    encryptionKey: randomBytes(32),
    instanceId: 'trigger-test',
  });
}

/** One-pipe workflow whose source is the trigger pipe for `type`. */
function workflowWith(
  id: string,
  triggers: unknown[],
  sourceType = 'source.triggerPayload',
  extras: Record<string, unknown> = {},
): WorkflowDef {
  return parseWorkflow({
    id,
    name: id,
    triggers,
    ...extras,
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
  payload?: unknown,
): TriggerInvocation {
  return {
    id: `inv-${kind}-${triggerId}`,
    workflowId: workflow.id,
    triggerId,
    kind,
    acceptedAt: '2026-07-18T00:00:00.000Z',
    ...(payload !== undefined ? { payload } : {}),
    metadata: {},
  };
}

/** Records the trigger source pipe emitted for the run's single pipeline. */
async function runRecords(
  engine: Engine,
  workflow: WorkflowDef,
  inv?: TriggerInvocation,
): Promise<{ status: string; processedRecords: number }> {
  const result = await engine.scheduler.enqueue(workflow, inv);
  await engine.idle();
  const run = await engine.stores.runs.get(result.run!.id);
  const pipes = await engine.stores.runs.listPipes(result.run!.id);
  return {
    status: run?.status ?? 'missing',
    processedRecords: pipes[0]?.processedRecords ?? 0,
  };
}

describe('trigger kinds — activation paths', () => {
  it('runs a manual trigger and passes inputData through as the payload', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'manual-wf',
      [
        {
          id: 'manual',
          kind: 'manual',
          enabled: true,
          inputData: [{ orderId: 1 }, { orderId: 2 }],
        },
      ],
      'source.trigger.manual',
    );
    await engine.stores.workflows.put(workflow);

    // No invocation supplied — the scheduler synthesizes the manual one.
    const outcome = await runRecords(engine, workflow);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.processedRecords).toBe(2);
    engine.close();
  });

  it('runs a cron trigger with the engine-generated scheduledAt payload', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'cron-wf',
      [
        {
          id: 'nightly',
          kind: 'cron',
          enabled: true,
          cron: '0 0 * * *',
          timezone: 'UTC',
          catchUp: 'one',
          executionType: 'workflow',
        },
      ],
      'source.trigger.cron',
    );
    await engine.stores.workflows.put(workflow);
    await engine.stores.schedules.put({
      workflowId: workflow.id,
      triggerId: 'nightly',
      nextFireAt: '2026-07-18T00:00:00.000Z',
      // Must match the coordinator's fingerprint, else it treats the schedule
      // as edited and re-bases nextFireAt instead of firing.
      scheduleFingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            cron: '0 0 * * *',
            timezone: 'UTC',
            executionType: 'workflow',
            http: null,
          }),
        )
        .digest('hex'),
    });

    // Drive the real coordinator so the cron path builds its own invocation.
    const cron = new CronCoordinator({
      workflows: engine.stores.workflows,
      schedules: engine.stores.schedules,
      scheduler: engine.scheduler,
      now: () => new Date('2026-07-18T00:01:00.000Z'),
    });
    await cron.recover();
    await engine.idle();

    const runs = await engine.stores.runs.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    // `trigger` records the kind; `triggerId` the specific trigger.
    expect(runs[0]!.trigger).toBe('cron');
    expect(runs[0]!.triggerId).toBe('nightly');
    engine.close();
  });

  it('runs webhook triggers from their ingress invocations, one record per array item', async () => {
    const engine = engineFor();
    const secret = await engine.stores.credentials.create({
      name: 'hook',
      kind: 'webhook',
      data: { signingSecret: 'shh' },
    });
    const workflow = workflowWith('ingress-wf', [
      {
        id: 'hook',
        kind: 'webhook',
        enabled: true,
        credentialId: secret.id,
      },
      { id: 'batch', kind: 'webhook', enabled: true, credentialId: secret.id },
    ]);
    await engine.stores.workflows.put(workflow);

    const hook = await runRecords(
      engine,
      workflow,
      invocation(workflow, 'hook', 'webhook', { event: 'created' }),
    );
    expect(hook).toEqual({ status: 'succeeded', processedRecords: 1 });

    const batch = await runRecords(
      engine,
      workflow,
      invocation(workflow, 'batch', 'webhook', [{ a: 1 }, { b: 2 }]),
    );
    expect(batch).toEqual({ status: 'succeeded', processedRecords: 2 });
    engine.close();
  });

  it('runs an internally dispatched trigger through the shared path', async () => {
    const engine = engineFor();
    const workflow = workflowWith('new-kinds-wf', [
      { id: 'parent', kind: 'parent', enabled: true },
    ]);
    await engine.stores.workflows.put(workflow);

    for (const [triggerId, kind] of [['parent', 'parent']] as const) {
      const outcome = await runRecords(
        engine,
        workflow,
        invocation(workflow, triggerId, kind, { from: kind }),
      );
      expect(outcome, `${kind} trigger`).toEqual({
        status: 'succeeded',
        processedRecords: 1,
      });
    }
    engine.close();
  });

  it('synthesizes a record when a parent trigger fires without a payload', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'no-payload-wf',
      [{ id: 'evt', kind: 'parent', enabled: true }],
      'source.trigger.parent',
    );
    await engine.stores.workflows.put(workflow);

    const outcome = await runRecords(
      engine,
      workflow,
      invocation(workflow, 'evt', 'parent'),
    );
    // A payload-less activation still yields one "triggered" marker record.
    expect(outcome).toEqual({ status: 'succeeded', processedRecords: 1 });
    engine.close();
  });

  it('rejects disabled triggers and kind mismatches at admission', async () => {
    const engine = engineFor();
    const workflow = workflowWith('guard-wf', [
      { id: 'parent', kind: 'parent', enabled: false },
      { id: 'evt', kind: 'parent', enabled: true },
    ]);
    await engine.stores.workflows.put(workflow);

    await expect(
      engine.scheduler.enqueue(
        workflow,
        invocation(workflow, 'parent', 'parent'),
      ),
    ).rejects.toThrow(/trigger is disabled/);

    // Claiming the wrong kind for a real trigger id must not admit a run.
    await expect(
      engine.scheduler.enqueue(workflow, invocation(workflow, 'evt', 'webhook')),
    ).rejects.toThrow(/invalid trigger invocation/);

    await expect(
      engine.scheduler.enqueue(
        workflow,
        invocation(workflow, 'ghost', 'parent'),
      ),
    ).rejects.toThrow(/invalid trigger invocation/);
    expect(await engine.stores.runs.list()).toEqual([]);
    engine.close();
  });

  it('enforces inputSchema on every external kind but exempts cron', async () => {
    const engine = engineFor();
    const workflow = workflowWith(
      'contract-wf',
      [
        { id: 'evt', kind: 'parent', enabled: true },
        {
          id: 'nightly',
          kind: 'cron',
          enabled: true,
          cron: '0 0 * * *',
          timezone: 'UTC',
          catchUp: 'none',
          executionType: 'workflow',
        },
      ],
      'source.triggerPayload',
      { inputSchema: { type: 'object', required: ['orderId'] } },
    );
    await engine.stores.workflows.put(workflow);

    await expect(
      engine.scheduler.enqueue(
        workflow,
        invocation(workflow, 'evt', 'parent', { wrong: true }),
      ),
    ).rejects.toMatchObject({ name: 'WorkflowInputError' });

    // Cron's engine-generated payload bypasses the contract.
    const cronRun = await engine.scheduler.enqueue(
      workflow,
      invocation(workflow, 'nightly', 'cron', {
        scheduledAt: '2026-07-18T00:00:00.000Z',
      }),
    );
    expect(cronRun.accepted).toBe(true);
    await engine.idle();
    engine.close();
  });

  it('fails a trigger source pipe fed the wrong invocation kind', async () => {
    const engine = engineFor();
    // The node says "webhook" but the run is activated by a parent trigger.
    const workflow = workflowWith(
      'mismatch-wf',
      [{ id: 'evt', kind: 'parent', enabled: true }],
      'source.trigger.webhook',
    );
    await engine.stores.workflows.put(workflow);

    const outcome = await runRecords(
      engine,
      workflow,
      invocation(workflow, 'evt', 'parent', { a: 1 }),
    );
    expect(outcome.status).toBe('failed');
    engine.close();
  });
});
