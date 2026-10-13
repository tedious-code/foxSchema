/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A sink instance serves every run. The CSV sink remembers, per run and file,
 * that it has written the header (and truncated, in overwrite mode) — and kept
 * that for every run the engine ever ran. The engine now tells sinks when a
 * run is over, and the entry goes.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, parseWorkflow, type PipeDef } from '../index.js';
import { FILES_DIR_ENV } from '../pipes/utility/file-root.js';

let root = '';
let previous: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'foxflow-sink-run-'));
  previous = process.env[FILES_DIR_ENV];
  process.env[FILES_DIR_ENV] = root;
});
afterEach(async () => {
  if (previous === undefined) delete process.env[FILES_DIR_ENV];
  else process.env[FILES_DIR_ENV] = previous;
  await rm(root, { recursive: true });
});

describe('a sink at the end of a run', () => {
  it('is told the run is over, and forgets it', async () => {
    await writeFile(join(root, 'in.csv'), 'name,outcome\nDana,sold\nAli,callback\n');
    const engine = new Engine({
      databasePath: ':memory:',
      encryptionKey: randomBytes(32),
      instanceId: 'sink-run',
    });
    const workflow = parseWorkflow({
      id: 'copy',
      name: 'copy',
      triggers: [{ id: 'manual', kind: 'manual', enabled: true }],
      pipelines: [
        {
          id: 'main',
          name: 'main',
          pipes: [
            {
              id: 'src',
              role: 'source',
              type: 'source.file.csv',
              config: { path: 'in.csv' },
            },
            {
              id: 'out',
              role: 'sink',
              type: 'sink.file.delimited',
              config: {
                path: 'out.csv',
                columns: ['name', 'outcome'],
                mode: 'overwrite',
              },
            },
          ],
          edges: [{ from: 'src', to: 'out' }],
        },
      ],
    });
    const sink = engine.registry.get({
      id: 'out',
      role: 'sink',
      type: 'sink.file.delimited',
      config: { path: 'out.csv', columns: ['name'] },
      concurrency: 1,
    } as PipeDef) as unknown as {
      finishRun(runId: string): void;
      started: Set<string>;
    };
    const finished = vi.spyOn(sink, 'finishRun');
    try {
      await engine.stores.workflows.put(workflow);
      const { run } = await engine.scheduler.enqueue(workflow);
      await engine.idle();

      expect((await engine.stores.runs.get(run!.id))?.status).toBe('succeeded');
      expect(await readFile(join(root, 'out.csv'), 'utf8')).toBe('name,outcome\nDana,sold\nAli,callback\n');
      expect(finished).toHaveBeenCalledWith(run!.id);
      expect([...sink.started].filter((key) => key.startsWith(`${run!.id}:`))).toEqual([]);
    } finally {
      // A failed assertion must not leave the engine's timers holding the run open.
      await engine.close();
    }
  });
});
