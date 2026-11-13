/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (apps/api/src/human-input-routes.test.ts).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createContext, type AppContext } from './context.js';

/**
 * The endpoints a person's form actually talks to — a page in the designer, a
 * link opened on a phone, or a script. Tested here rather than only through
 * the engine because "the UI validates it" is not validation: anything can
 * POST to these.
 */

function testContext(): AppContext {
  return createContext({
    databasePath: ':memory:',
    encryptionKey: randomBytes(32),
  });
}

const RUN_ID = 'run-otp-1';

/** A run parked on a question, without executing a workflow to get there. */
async function parkedRun(ctx: AppContext): Promise<void> {
  await ctx.runs.create(
    {
      id: RUN_ID,
      workflowId: 'wf',
      workflowVersion: 1,
      status: 'paused',
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      instanceId: 'test',
    } as never,
    {
      id: 'wf',
      name: 'wf',
      version: 1,
      triggers: [{ id: 't', kind: 'manual', enabled: true }],
      pipelines: [{ id: 'main', name: 'Main', pipes: [], edges: [] }],
    } as never,
  );
  await ctx.humanInputs.request({
    workflowRunId: RUN_ID,
    pipelineId: 'main',
    pipeId: 'ask',
    request: {
      key: 'otp',
      prompt: 'Enter the code we texted you',
      fields: [
        {
          key: 'code',
          label: 'Code',
          type: 'otp',
          secret: true,
          optional: false,
          pattern: '\\d{6}',
        },
      ],
      channel: 'sms',
      expiresInSeconds: 900,
    },
    now: new Date().toISOString(),
  });
}

describe('answering a run that is waiting for a person', () => {
  it('describes the form to render, without leaking an answer', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);
    try {
      await parkedRun(ctx);
      await ctx.humanInputs.answer(
        RUN_ID,
        'otp',
        { code: '999111' },
        new Date().toISOString(),
      );
      // Ask again so there is a pending question alongside an answered one.
      await ctx.humanInputs.request({
        workflowRunId: RUN_ID,
        pipelineId: 'main',
        pipeId: 'ask',
        request: {
          key: 'otp',
          prompt: 'Enter the code we texted you',
          fields: [
            { key: 'code', label: 'Code', type: 'otp', secret: true, optional: false },
          ],
          channel: 'sms',
          expiresInSeconds: 900,
        },
        now: new Date().toISOString(),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/runs/${RUN_ID}/inputs`,
      });

      expect(response.statusCode).toBe(200);
      // Enough to build the form …
      expect(response.json().pending[0].prompt).toMatch(/code we texted/);
      expect(response.json().pending[0].fields[0].key).toBe('code');
      // … and nothing that was ever typed in. Returning answers here would
      // make this endpoint a way to read back every OTP the install has seen.
      expect(response.body).not.toContain('999111');
    } finally {
      await app.close();
    }
  });

  it('rejects an answer that does not match the declared format', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);
    try {
      await parkedRun(ctx);

      const response = await app.inject({
        method: 'POST',
        url: `/api/runs/${RUN_ID}/inputs`,
        payload: { key: 'otp', values: { code: 'letmein' } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().problems).toContain(
        'code does not match the expected format',
      );
      // Still waiting: a rejected answer must not consume the question.
      expect(await ctx.humanInputs.pending(RUN_ID)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('anchors the pattern, so a longer string cannot slip through', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);
    try {
      await parkedRun(ctx);

      // `\d{6}` unanchored matches inside `abc123456xyz`. For a one-time code
      // that is precisely the wrong answer.
      const response = await app.inject({
        method: 'POST',
        url: `/api/runs/${RUN_ID}/inputs`,
        payload: { key: 'otp', values: { code: 'abc123456xyz' } },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('refuses to answer the same question twice', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);
    try {
      await parkedRun(ctx);
      await ctx.humanInputs.answer(
        RUN_ID,
        'otp',
        { code: '123456' },
        new Date().toISOString(),
      );

      // Answering an already-answered question would resume a run whose pipe
      // then reads a stale code — a replayed OTP, on a run someone else moved.
      const response = await app.inject({
        method: 'POST',
        url: `/api/runs/${RUN_ID}/inputs`,
        payload: { key: 'otp', values: { code: '654321' } },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatch(/answered/);
    } finally {
      await app.close();
    }
  });

  it('does not write a secret answer into the run event log', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);
    try {
      await parkedRun(ctx);

      await app.inject({
        method: 'POST',
        url: `/api/runs/${RUN_ID}/inputs`,
        payload: { key: 'otp', values: { code: '123456' } },
      });

      const events = await ctx.events.list(RUN_ID);
      const received = events.find((e) => e.type === 'human.input.received');
      expect(received).toBeDefined();
      // The log records that it was answered, never with what.
      expect(JSON.stringify(events)).not.toContain('123456');
      expect(JSON.stringify(received?.data)).toContain('[redacted]');
    } finally {
      await app.close();
    }
  });
});
