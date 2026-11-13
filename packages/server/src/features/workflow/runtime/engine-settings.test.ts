/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The engine takes its admission settings and log sinks from FoxSchema, and
 * keeps the last ones it had when FoxSchema cannot be reached.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeConfig } from '@foxschema/workflow-contract';
import type { RunEvent } from '@foxschema/workflow-engine';
import { EngineConfigSync } from './engine-settings.js';
import { RunEventSinks, formatTextLine } from './run-event-sinks.js';

const CONFIG: EngineRuntimeConfig = {
  state: 'draining',
  maxParallel: 3,
  sinks: [{ kind: 'json', enabled: true, target: 'runs.jsonl' }],
};

function sync(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { WORKFLOW_ENGINE_TOKEN: 'tok' }) {
  const scheduler = { setAdmission: vi.fn() };
  const sinks = { configure: vi.fn() };
  const errors: string[] = [];
  const instance = new EngineConfigSync({ scheduler, sinks, env, fetch: fetchImpl, onError: (m) => errors.push(m) });
  return { instance, scheduler, sinks, errors };
}

describe('EngineConfigSync', () => {
  it('applies what FoxSchema saved, asking with the service token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(CONFIG));
    const s = sync(fetchImpl as unknown as typeof fetch, {
      WORKFLOW_ENGINE_TOKEN: 'tok',
      FOXSCHEMA_URL: 'http://fox.test:3210/',
    });

    await s.instance.refresh();

    expect(fetchImpl.mock.calls[0]![0]).toBe('http://fox.test:3210/api/workflow-internal/engine-config');
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get('authorization')).toBe('Bearer tok');
    expect(s.scheduler.setAdmission).toHaveBeenCalledWith({ state: 'draining', maxConcurrentRuns: 3 });
    expect(s.sinks.configure).toHaveBeenCalledWith(CONFIG.sinks);
  });

  it('keeps the last settings when FoxSchema cannot answer', async () => {
    const s = sync((async () => new Response(null, { status: 502 })) as unknown as typeof fetch);
    expect(await s.instance.refresh()).toBeUndefined();
    expect(s.scheduler.setAdmission).not.toHaveBeenCalled();
    expect(s.errors[0]).toMatch(/HTTP 502/);
  });

  it('ignores an answer with a state it does not know', async () => {
    const s = sync((async () => Response.json({ ...CONFIG, state: 'sideways' })) as unknown as typeof fetch);
    await s.instance.refresh();
    expect(s.scheduler.setAdmission).not.toHaveBeenCalled();
  });

  it('does not start without a token', () => {
    const fetchImpl = vi.fn();
    const s = sync(fetchImpl as unknown as typeof fetch, {});
    expect(s.instance.start()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('RunEventSinks', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const event = (seq: number, extra: Partial<RunEvent> = {}): RunEvent => ({
    seq,
    workflowRunId: 'run-1',
    at: `2026-09-14T10:00:0${seq}.000Z`,
    type: 'pipe.log',
    pipelineId: 'load',
    pipeId: 'write',
    message: `line ${seq}`,
    data: { level: 'warn' },
    ...extra,
  });

  it('appends JSON lines and readable lines to files in the log directory', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fox-sinks-'));
    const sinks = new RunEventSinks(directory);
    sinks.configure([
      { kind: 'events', enabled: true },
      { kind: 'json', enabled: true, target: 'runs.jsonl' },
      { kind: 'text', enabled: true },
    ]);
    sinks.write(event(1));
    sinks.write(event(2, { type: 'run.status', message: undefined, pipelineId: undefined, pipeId: undefined, data: { status: 'succeeded' } }));
    await sinks.close();

    const json = (await readFile(join(directory, 'runs.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(json.map((row: RunEvent) => row.seq)).toEqual([1, 2]);
    expect(await readFile(join(directory, 'run-events.log'), 'utf8')).toBe(
      '2026-09-14T10:00:01.000Z WARN run=run-1 load/write line 1\n' +
        '2026-09-14T10:00:02.000Z run.status run=run-1 succeeded\n',
    );
  });

  it('refuses a target that is a path, and writes nothing without a directory', async () => {
    directory = await mkdtemp(join(tmpdir(), 'fox-sinks-'));
    const errors: string[] = [];
    const sinks = new RunEventSinks(directory, (message) => errors.push(message));
    sinks.configure([{ kind: 'json', enabled: true, target: '../escaped.jsonl' }]);
    expect(errors[0]).toMatch(/file name, not a path/);
    await sinks.close();

    const nowhere: string[] = [];
    new RunEventSinks(undefined, (message) => nowhere.push(message)).configure([{ kind: 'text', enabled: true }]);
    expect(nowhere[0]).toMatch(/no log directory/);
  });

  it('formats a line without the parts an event does not have', () => {
    expect(formatTextLine(event(3, { data: undefined, pipeId: undefined }))).toBe(
      '2026-09-14T10:00:03.000Z pipe.log run=run-1 load line 3',
    );
  });
});
