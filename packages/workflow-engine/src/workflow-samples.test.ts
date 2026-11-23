/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The built-in workflow samples (Workflows → "Add samples"), run the way a
 * Test run runs them: saved past the checks the API makes, enqueued with no
 * invocation so the manual trigger's own input is used, and expected to end
 * `succeeded`.
 *
 * Samples that need the internet (Open-Meteo) or PostgreSQL run only with
 * FOXFLOW_IT_SAMPLES=1, against the `docker compose` database that
 * credential-less Postgres steps fall back to.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_SAMPLES } from '../../../apps/web/src/frontend/features/workflow/lib/workflowSamples.js';
import { parseWorkflow } from './common/index.js';
import { assertRunnableRoots } from './compiler/index.js';
import { Engine } from './engine.js';
import { openRunMemoryDatabases } from './pipes/db/sql.js';
import { assertKnownFromPorts } from './runtime/index.js';

type Sample = (typeof WORKFLOW_SAMPLES)[number];

function pipesOf(sample: Sample) {
  return sample.document.pipelines.flatMap((pipeline) => pipeline.pipes);
}

/** Reaches the internet: an HTTP source or transform. */
function needsNetwork(sample: Sample): boolean {
  return pipesOf(sample).some((pipe) => pipe.type.includes('.http'));
}

/** Writes or reads PostgreSQL (a SQL step for any dialect but SQLite). */
function needsPostgres(sample: Sample): boolean {
  return pipesOf(sample).some(
    (pipe) => pipe.type.startsWith('source.db.') || pipe.type.startsWith('sink.db.')
      ? pipe.config.dialect !== 'sqlite'
      : false,
  );
}

const LOCAL = WORKFLOW_SAMPLES.filter((sample) => !needsNetwork(sample) && !needsPostgres(sample));
const REMOTE = WORKFLOW_SAMPLES.filter((sample) => needsNetwork(sample) || needsPostgres(sample));

let engine: Engine;
let filesDir: string;

beforeAll(() => {
  // File sinks write under this root; keep each run's CSVs out of the shared temp dir.
  filesDir = mkdtempSync(join(tmpdir(), 'fox-samples-'));
  vi.stubEnv('FOXFLOW_FILES_DIR', filesDir);
  engine = new Engine({
    databasePath: ':memory:',
    encryptionKey: randomBytes(32),
    instanceId: 'workflow-samples-test',
  });
});

afterAll(() => {
  engine?.close();
  vi.unstubAllEnvs();
  rmSync(filesDir, { recursive: true, force: true });
});

/** Run a sample twice: a second Test run must replace rows, not collide with them. */
async function testRun(sample: Sample) {
  const workflow = parseWorkflow(sample.document);
  await engine.stores.workflows.put(workflow);
  const outcomes = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { run } = await engine.scheduler.enqueue(workflow, undefined);
    await engine.idle();
    const record = await engine.stores.runs.get(run!.id);
    const failures = (await engine.stores.runs.listPipelines(run!.id))
      .filter((pipeline) => pipeline.status === 'failed')
      .map((pipeline) => `${pipeline.pipelineId}: ${pipeline.error}`);
    // The in-memory database the run's SQLite steps shared is closed with it.
    outcomes.push({ status: record?.status, failures, openMemoryDatabases: openRunMemoryDatabases() });
  }
  return outcomes;
}

describe('built-in workflow samples', () => {
  it('passes the checks a save makes: pipe types, their config, roots and ports', () => {
    const refused: string[] = [];
    for (const sample of WORKFLOW_SAMPLES) {
      const workflow = parseWorkflow(sample.document);
      for (const pipeline of workflow.pipelines) {
        try {
          assertRunnableRoots(pipeline);
          for (const pipe of pipeline.pipes) engine.registry.get(pipe);
          assertKnownFromPorts(
            engine.registry,
            new Map(pipeline.pipes.map((pipe) => [pipe.id, pipe])),
            pipeline.edges,
          );
        } catch (error) {
          refused.push(`${sample.id} / ${pipeline.id}: ${(error as Error).message}`);
        }
      }
    }
    expect(refused).toEqual([]);
  });

  it('runs every sample that needs neither the network nor PostgreSQL', () => {
    // The split is derived, so pin it: a sample silently moving to the gated
    // group would no longer be run by default.
    expect(LOCAL.map((sample) => sample.id).sort()).toEqual([
      'sample-cdc-watermark-incremental-sync',
      'sample-dedupe-nulls-quarantine-etl',
      'sample-empty-batch-and-loop-edge',
      'sample-hello-records',
      'sample-mapped-db-composite-upsert',
      'sample-orders-branch',
      'sample-regions-join',
      'sample-sql-crud',
      'sample-webhook-ingest-aggregate-db',
    ]);
  });

  it.each(LOCAL.map((sample) => [sample.id, sample] as const))(
    '%s succeeds on a Test run',
    async (_id, sample) => {
      const ok = { status: 'succeeded', failures: [], openMemoryDatabases: 0 };
      expect(await testRun(sample)).toEqual([ok, ok]);
    },
    60_000,
  );

  describe.runIf(process.env.FOXFLOW_IT_SAMPLES === '1')('with the network and docker compose PostgreSQL', () => {
    it.each(REMOTE.map((sample) => [sample.id, sample] as const))(
      '%s succeeds on a Test run',
      async (_id, sample) => {
        const ok = { status: 'succeeded', failures: [], openMemoryDatabases: 0 };
        expect(await testRun(sample)).toEqual([ok, ok]);
      },
      120_000,
    );
  });
});
