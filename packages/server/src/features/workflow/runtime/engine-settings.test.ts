/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The engine takes its admission settings and log sinks from FoxSchema, and
 * keeps the last ones it had when that read fails.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineRuntimeConfig } from '@foxschema/shared';
import type { RunEvent } from '@foxschema/workflow-engine';
import { EngineConfigSync } from './engine-settings.js';
import { RunEventSinks, formatTextLine } from './run-event-sinks.js';

const CONFIG: EngineRuntimeConfig = {
  state: 'draining',
  maxParallel: 3,
  sinks: [{ kind: 'json', enabled: true, target: 'runs.jsonl' }],
};

function sync(load: () => Promise<EngineRuntimeConfig>) {
  const scheduler = { setAdmission: vi.fn() };
  const sinks = { configure: vi.fn() };
  const errors: string[] = [];
  const instance = new EngineConfigSync({ scheduler, sinks, load, onError: (m) => errors.push(m) });
  return { instance, scheduler, sinks, errors };
}

describe('EngineConfigSync', () => {
  it('applies what FoxSchema saved', async () => {
    const s = sync(async () => CONFIG);
    await s.instance.refresh();
    expect(s.scheduler.setAdmission).toHaveBeenCalledWith({ state: 'draining', maxConcurrentRuns: 3 });
    expect(s.sinks.configure).toHaveBeenCalledWith(CONFIG.sinks);
  });

  it('keeps the last settings when the load fails', async () => {
    const s = sync(async () => {
      throw new Error('store down');
    });
    expect(await s.instance.refresh()).toBeUndefined();
    expect(s.scheduler.setAdmission).not.toHaveBeenCalled();
    expect(s.errors[0]).toMatch(/store down/);
  });

  it('ignores an answer with a state it does not know', async () => {
    const s = sync(async () => ({ ...CONFIG, state: 'sideways' as EngineRuntimeConfig['state'] }));
    await s.instance.refresh();
    expect(s.scheduler.setAdmission).not.toHaveBeenCalled();
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
