/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/storage/src/index.ts).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  buildStoredSecret,
  decrypt,
  encrypt,
  parseStoredSecret,
  resolveStoredSecret,
  type CreateCredentialInput,
  type CredentialMeta,
  type CredentialStore,
} from '../common/index.js';
import type {
  HumanInputRecord,
  HumanInputRequest,
  HumanInputStore,
  Checkpoint,
  CheckpointStore,
  EnvironmentRecord,
  EnvironmentStore,
  EventStore,
  NewRunEvent,
  PipeRunRecord,
  PipelineRunRecord,
  RunEvent,
  RunStore,
  TriggerInvocation,
  TriggerScheduleState,
  TriggerScheduleStore,
  WorkflowSummaryRecord,
  VariableRecord,
  VariableScope,
  VariableStore,
  WorkflowDef,
  WorkflowRunRecord,
  WorkflowStore,
} from '../index.js';
import { normalizeWorkflowDocument } from '../common/index.js';

export {
  DEFAULT_DATABASE_FILENAME,
  resolveDatabasePath,
} from './database-path.js';

type Row = Record<string, unknown>;

const TRIGGER_STATE_MIGRATION_VERSION = 5;

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      secret TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      instance_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_runs_workflow_id
      ON workflow_runs(workflow_id, started_at);
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      UNIQUE(workflow_run_id, pipeline_id)
    );
    CREATE TABLE IF NOT EXISTS pipe_runs (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      pipe_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      processed_batches INTEGER NOT NULL,
      processed_records INTEGER NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT,
      UNIQUE(workflow_run_id, pipeline_id, pipe_id)
    );
    CREATE TABLE IF NOT EXISTS run_events (
      workflow_run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      pipeline_id TEXT,
      pipe_id TEXT,
      message TEXT,
      data_json TEXT,
      PRIMARY KEY(workflow_run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      workflow_run_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      pipe_id TEXT NOT NULL,
      partition_id TEXT NOT NULL,
      cursor_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workflow_run_id, pipeline_id, pipe_id, partition_id)
    );
  `,
  `
    ALTER TABLE workflow_runs ADD COLUMN trigger_id TEXT;
    ALTER TABLE workflow_runs ADD COLUMN invocation_json TEXT;
    ALTER TABLE workflow_runs ADD COLUMN idempotency_key TEXT;
    CREATE UNIQUE INDEX workflow_runs_trigger_idempotency
      ON workflow_runs(workflow_id, trigger_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `,
  `
    CREATE TABLE trigger_schedules (
      workflow_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      next_fire_at TEXT NOT NULL,
      last_accepted_at TEXT,
      PRIMARY KEY(workflow_id, trigger_id)
    );
    CREATE INDEX trigger_schedules_next_fire_at
      ON trigger_schedules(next_fire_at);
  `,
  `
    ALTER TABLE trigger_schedules ADD COLUMN schedule_fingerprint TEXT;
  `,
  `
    SELECT 1;
  `,
  `
    ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT;
    CREATE INDEX workflow_runs_parent_run_id
      ON workflow_runs(parent_run_id)
      WHERE parent_run_id IS NOT NULL;
  `,
  `
    CREATE TABLE environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- At most one active environment, enforced by the index rather than by
    -- application code (two actives would make run resolution ambiguous).
    CREATE UNIQUE INDEX environments_single_active
      ON environments(is_active) WHERE is_active = 1;

    CREATE TABLE variables (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'workflow')),
      -- '' for global rows so the unique index works (SQLite treats NULLs as
      -- distinct, which would allow duplicate global keys).
      workflow_id TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((scope = 'global') = (workflow_id = ''))
    );
    CREATE UNIQUE INDEX variables_unique
      ON variables(environment_id, scope, workflow_id, key);
    CREATE INDEX variables_lookup
      ON variables(environment_id, workflow_id);

    -- Resolved variables are snapshotted onto the run, like the workflow
    -- definition, so a replay/resume sees the values the run started with.
    ALTER TABLE workflow_runs ADD COLUMN environment_id TEXT;
    ALTER TABLE workflow_runs ADD COLUMN variables_json TEXT;
  `,
  `
    -- Opt-in I/O sample capture for designer debug runs.
    ALTER TABLE workflow_runs ADD COLUMN debug INTEGER NOT NULL DEFAULT 0;
  `,
  `
    -- Credential secret backend (local encrypt / env / GCP / AWS / Azure).
    ALTER TABLE credentials ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
  `,
  `
    -- A run being executed carries a lease its owner renews. Without one, an
    -- instance starting up reclaimed every run in 'running' state — including a
    -- live peer's — and re-executed it. NULL means "no lease", which is how
    -- every run written before this migration looks, and stays reclaimable so
    -- single-instance recovery behaves exactly as it did.
    ALTER TABLE workflow_runs ADD COLUMN lease_expires_at TEXT;
  `,
  `
    -- Human-in-the-loop: what a paused run is waiting for a person to supply.
    -- UNIQUE(workflow_run_id, key) is the idempotency the pipe depends on: it
    -- is re-executed on resume and must re-ask without stacking duplicates.
    -- The answer is encrypted because an OTP or an auth code in plain text
    -- would outlive its usefulness by years sitting in this file.
    CREATE TABLE IF NOT EXISTS human_inputs (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      pipe_id TEXT NOT NULL,
      key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      answered_at TEXT,
      answer_encrypted TEXT,
      UNIQUE(workflow_run_id, key)
    );
    CREATE INDEX IF NOT EXISTS human_inputs_pending
      ON human_inputs(status, expires_at);
  `,
  `
    -- Poll triggers remember which dedup keys they have already seen, so a
    -- poll that returns the same items twice creates one run, not two. NULL
    -- means "never polled" — distinct from "polled, saw nothing" ('[]'), which
    -- is why this is nullable rather than defaulting to an empty array.
    ALTER TABLE trigger_schedules ADD COLUMN seen_keys_json TEXT;
  `,
  `
    -- The runs list reads newest first across every workflow, and the
    -- scheduler looks runs up by status to find what is queued or still
    -- active. Without these both scan every run ever recorded.
    CREATE INDEX IF NOT EXISTS workflow_runs_started_at ON workflow_runs(started_at);
    CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs(status, workflow_id);
  `,
] as const;

function migrate(db: DatabaseSync, encryptionKey: Buffer): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = ?',
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
  );
  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    if (applied.get(version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      if (version === TRIGGER_STATE_MIGRATION_VERSION) {
        migrateTriggerState(db, encryptionKey);
      }
      record.run(version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function migrateTriggerState(db: DatabaseSync, encryptionKey: Buffer): void {
  migrateIdempotencyKeys(db, encryptionKey);
}

function migrateIdempotencyKeys(
  db: DatabaseSync,
  encryptionKey: Buffer,
): void {
  const updateRun = db.prepare(
    'UPDATE workflow_runs SET idempotency_key = ? WHERE id = ?',
  );
  const runs = db
    .prepare(
      `SELECT id, idempotency_key, invocation_json FROM workflow_runs
       WHERE idempotency_key IS NOT NULL`,
    )
    .all() as Row[];
  for (const row of runs) {
    const invocation = row.invocation_json
      ? (JSON.parse(
          decrypt(String(row.invocation_json), encryptionKey),
        ) as TriggerInvocation)
      : undefined;
    const sourceKey =
      invocation?.idempotencyKey ?? String(row.idempotency_key);
    updateRun.run(
      idempotencyHash(sourceKey, encryptionKey),
      String(row.id),
    );
  }
}

class SqliteWorkflowStore implements WorkflowStore {
  constructor(private readonly db: DatabaseSync) {}

  async put(workflow: WorkflowDef): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workflows(id, version, definition_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           definition_json = excluded.definition_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        workflow.id,
        workflow.version,
        JSON.stringify(workflow),
        new Date().toISOString(),
      );
  }

  async get(id: string): Promise<WorkflowDef | undefined> {
    const row = this.db
      .prepare('SELECT definition_json FROM workflows WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? storedWorkflow(row.definition_json) : undefined;
  }

  async summaries(): Promise<WorkflowSummaryRecord[]> {
    return (
      this.db
        .prepare('SELECT id, version, updated_at FROM workflows ORDER BY id')
        .all() as Row[]
    ).map((row) => ({
      id: String(row.id),
      version: Number(row.version),
      updatedAt: String(row.updated_at),
    }));
  }

  async remove(id: string): Promise<boolean> {
    // Run history is unaffected: runs keep their own immutable snapshot of the
    // definition, so deleting a workflow never breaks past runs.
    const result = this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  async list(): Promise<WorkflowDef[]> {
    return (
      this.db
        .prepare('SELECT definition_json FROM workflows ORDER BY id')
        .all() as Row[]
    ).map((row) => storedWorkflow(row.definition_json));
  }
}

/**
 * Read a stored workflow, applying the shape lifts `parseWorkflow` applies.
 *
 * Rows are written as raw JSON and never re-validated on read, so a workflow
 * saved before a shape changed would otherwise keep the old shape forever —
 * a webhook stored before `auth` existed would reach the router with no `auth`
 * at all. The lifts are no-ops for anything already current.
 */
function storedWorkflow(value: unknown): WorkflowDef {
  return normalizeWorkflowDocument(json<WorkflowDef>(value)) as WorkflowDef;
}

class SqliteCredentialStore implements CredentialStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
    private readonly resolveFoxSchemaConnection?: (
      connectionId: string,
    ) => Promise<Record<string, unknown> | undefined>,
  ) {}

  async create(input: CreateCredentialInput): Promise<CredentialMeta> {
    const id = input.id?.trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    const source = input.source ?? 'local';
    const payload = buildStoredSecret(source, input.data);
    const secret = encrypt(JSON.stringify(payload), this.key);
    const existing = this.db
      .prepare(
        `SELECT id, name, kind, source, created_at, updated_at
         FROM credentials WHERE id = ?`,
      )
      .get(id) as Row | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE credentials
           SET name = ?, kind = ?, source = ?, secret = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.name, input.kind, source, secret, now, id);
      return {
        id,
        name: input.name,
        kind: input.kind,
        source,
        createdAt: String(existing.created_at),
        updatedAt: now,
      };
    }
    this.db
      .prepare(
        `INSERT INTO credentials(id, name, kind, source, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.kind, source, secret, now, now);
    return {
      id,
      name: input.name,
      kind: input.kind,
      source,
      createdAt: now,
      updatedAt: now,
    };
  }

  async list(): Promise<CredentialMeta[]> {
    return (
      this.db
        .prepare(
          `SELECT id, name, kind, source, created_at, updated_at
           FROM credentials ORDER BY created_at, id`,
        )
        .all() as Row[]
    ).map(credentialMeta);
  }

  async get(id: string): Promise<CredentialMeta | undefined> {
    const row = this.db
      .prepare(
        `SELECT id, name, kind, source, created_at, updated_at
         FROM credentials WHERE id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? credentialMeta(row) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    return (
      this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
        .changes > 0
    );
  }

  async revealSecret(
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const row = this.db
      .prepare('SELECT secret FROM credentials WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) return undefined;
    const payload = parseStoredSecret(
      JSON.parse(decrypt(String(row.secret), this.key)) as Record<
        string,
        unknown
      >,
    );
    return resolveStoredSecret(
      payload,
      process.env,
      fetch,
      this.resolveFoxSchemaConnection,
    );
  }

  async updateSecret(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const row = this.db
      .prepare('SELECT secret FROM credentials WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row) return false;
    const payload = parseStoredSecret(
      JSON.parse(decrypt(String(row.secret), this.key)) as Record<
        string,
        unknown
      >,
    );
    const next = {
      ...payload,
      values: { ...(payload.values ?? {}), ...patch },
    };
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE credentials SET secret = ?, updated_at = ? WHERE id = ?`,
      )
      .run(encrypt(JSON.stringify(next), this.key), now, id);
    return true;
  }
}

class SqliteRunStore implements RunStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
  ) {}

  async create(
    run: WorkflowRunRecord,
    snapshot: WorkflowDef,
    invocation?: TriggerInvocation,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workflow_runs(
          id, workflow_id, workflow_version, status, trigger, started_at,
          finished_at, error, instance_id, snapshot_json, trigger_id,
          invocation_json, idempotency_key, parent_run_id,
          environment_id, variables_json, debug
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.workflowId,
        run.workflowVersion,
        run.status,
        run.trigger,
        run.startedAt,
        run.finishedAt ?? null,
        run.error ?? null,
        run.instanceId,
        JSON.stringify(snapshot),
        run.triggerId ?? invocation?.triggerId ?? null,
        invocation
          ? encrypt(JSON.stringify(invocation), this.key)
          : null,
        invocation?.idempotencyKey
          ? idempotencyHash(invocation.idempotencyKey, this.key)
          : null,
        run.parentRunId ?? null,
        run.environmentId ?? null,
        run.variables ? JSON.stringify(run.variables) : null,
        run.debug ? 1 : 0,
      );
  }

  /**
   * The `onOverlap: 'skip'` decision, made by the write itself.
   *
   * `INSERT … SELECT … WHERE NOT EXISTS` evaluates the guard and inserts in one
   * statement, so SQLite's single writer decides the race rather than two
   * schedulers each reading "none active" a millisecond apart. Returns whether
   * this caller created the run; a loser gets `false` and skips, exactly as if
   * it had lost to a run on its own instance.
   */
  async createIfIdle(
    run: WorkflowRunRecord,
    snapshot: WorkflowDef,
    invocation?: TriggerInvocation,
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO workflow_runs(
          id, workflow_id, workflow_version, status, trigger, started_at,
          finished_at, error, instance_id, snapshot_json, trigger_id,
          invocation_json, idempotency_key, parent_run_id,
          environment_id, variables_json, debug
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM workflow_runs
          WHERE workflow_id = ? AND status IN ('queued', 'running')
        )`,
      )
      .run(
        run.id,
        run.workflowId,
        run.workflowVersion,
        run.status,
        run.trigger,
        run.startedAt,
        run.finishedAt ?? null,
        run.error ?? null,
        run.instanceId,
        JSON.stringify(snapshot),
        run.triggerId ?? invocation?.triggerId ?? null,
        invocation ? encrypt(JSON.stringify(invocation), this.key) : null,
        invocation?.idempotencyKey
          ? idempotencyHash(invocation.idempotencyKey, this.key)
          : null,
        run.parentRunId ?? null,
        run.environmentId ?? null,
        run.variables ? JSON.stringify(run.variables) : null,
        run.debug ? 1 : 0,
        run.workflowId,
      );
    return Number(result.changes) > 0;
  }

  async get(id: string): Promise<WorkflowRunRecord | undefined> {
    const row = this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? workflowRun(row) : undefined;
  }

  async list(
    workflowId?: string,
    filter: { status?: readonly WorkflowRunRecord['status'][]; limit?: number } = {},
  ): Promise<WorkflowRunRecord[]> {
    // Built from fixed fragments, so the statement cache holds a handful of
    // variants rather than one per value.
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (workflowId) {
      where.push('workflow_id = ?');
      params.push(workflowId);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }
    if (filter.limit !== undefined) params.push(filter.limit);
    const rows = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${
           // `+started_at` stops SQLite ordering through the (workflow_id,
           // started_at) index, which made a status lookup walk every run of
           // the workflow; the status index finds the few active runs instead.
           filter.status?.length ? '+started_at' : 'started_at'
         } DESC${filter.limit !== undefined ? ' LIMIT ?' : ''}`,
      )
      .all(...params);
    return (rows as Row[]).map(workflowRun);
  }

  async claimQueuedRun(
    runId: string,
    instanceId: string,
    expiresAt: string,
    serial = false,
    now: string = new Date().toISOString(),
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE workflow_runs
         SET status = 'running', instance_id = ?, lease_expires_at = ?
         WHERE id = ? AND status = 'queued'
           AND (? = 0 OR NOT EXISTS (
             SELECT 1 FROM workflow_runs AS active
             WHERE active.workflow_id = workflow_runs.workflow_id
               AND active.status = 'running'
               AND active.id <> workflow_runs.id
               -- Only a live lease blocks. A crashed worker leaves its row
               -- 'running' with a lease that stops renewing; counting it would
               -- stall this workflow's queue until some process restarted and
               -- ran recover(), since the worker poll never reclaims leases.
               -- Same rule interruptRunning uses to decide reclaimability.
               AND active.lease_expires_at IS NOT NULL
               AND active.lease_expires_at >= ?
           ))`,
      )
      .run(instanceId, expiresAt, runId, serial ? 1 : 0, now);
    return Number(result.changes) > 0;
  }

  async update(run: WorkflowRunRecord): Promise<void> {
    this.db
      .prepare(
        `UPDATE workflow_runs SET
          status = ?, finished_at = ?, error = ?, instance_id = ?
         WHERE id = ?`,
      )
      .run(
        run.status,
        run.finishedAt ?? null,
        run.error ?? null,
        run.instanceId,
        run.id,
      );
  }

  async getSnapshot(id: string): Promise<WorkflowDef | undefined> {
    const row = this.db
      .prepare('SELECT snapshot_json FROM workflow_runs WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? json<WorkflowDef>(row.snapshot_json) : undefined;
  }

  async getInvocation(id: string): Promise<TriggerInvocation | undefined> {
    const row = this.db
      .prepare('SELECT invocation_json FROM workflow_runs WHERE id = ?')
      .get(id) as Row | undefined;
    if (!row?.invocation_json) return undefined;
    return JSON.parse(
      decrypt(String(row.invocation_json), this.key),
    ) as TriggerInvocation;
  }

  async findByIdempotencyKey(
    workflowId: string,
    triggerId: string,
    idempotencyKey: string,
  ): Promise<WorkflowRunRecord | undefined> {
    const row = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs
         WHERE workflow_id = ? AND trigger_id = ? AND idempotency_key = ?`,
      )
      .get(
        workflowId,
        triggerId,
        idempotencyHash(idempotencyKey, this.key),
      ) as Row | undefined;
    return row ? workflowRun(row) : undefined;
  }

  async putPipeline(record: PipelineRunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs(
          id, workflow_run_id, pipeline_id, status, started_at, finished_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_run_id, pipeline_id) DO UPDATE SET
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          error = excluded.error`,
      )
      .run(
        record.id,
        record.workflowRunId,
        record.pipelineId,
        record.status,
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.error ?? null,
      );
  }

  async listPipelines(workflowRunId: string): Promise<PipelineRunRecord[]> {
    return (
      this.db
        .prepare(
          'SELECT * FROM pipeline_runs WHERE workflow_run_id = ? ORDER BY pipeline_id',
        )
        .all(workflowRunId) as Row[]
    ).map(pipelineRun);
  }

  async putPipe(record: PipeRunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO pipe_runs(
          id, workflow_run_id, pipeline_id, pipe_id, status, attempt,
          processed_batches, processed_records, started_at, finished_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_run_id, pipeline_id, pipe_id) DO UPDATE SET
          status = excluded.status,
          attempt = excluded.attempt,
          processed_batches = excluded.processed_batches,
          processed_records = excluded.processed_records,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          error = excluded.error`,
      )
      .run(
        record.id,
        record.workflowRunId,
        record.pipelineId,
        record.pipeId,
        record.status,
        record.attempt,
        record.processedBatches,
        record.processedRecords,
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.error ?? null,
      );
  }

  async listPipes(
    workflowRunId: string,
    pipelineId?: string,
  ): Promise<PipeRunRecord[]> {
    const rows = pipelineId
      ? this.db
          .prepare(
            `SELECT * FROM pipe_runs
             WHERE workflow_run_id = ? AND pipeline_id = ?
             ORDER BY pipe_id`,
          )
          .all(workflowRunId, pipelineId)
      : this.db
          .prepare(
            'SELECT * FROM pipe_runs WHERE workflow_run_id = ? ORDER BY pipeline_id, pipe_id',
          )
          .all(workflowRunId);
    return (rows as Row[]).map(pipeRun);
  }

  /**
   * Renew this instance's claim on a run it is executing.
   *
   * A peer decides whether a run is abandoned by looking at the lease, so
   * whatever is still working has to keep saying so. Scoped to the owning
   * instance: renewing someone else's lease would hide a genuinely dead peer.
   */
  async renewLease(
    runId: string,
    instanceId: string,
    expiresAt: string,
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE workflow_runs SET lease_expires_at = ?
         WHERE id = ? AND instance_id = ? AND status = 'running'`,
      )
      .run(expiresAt, runId, instanceId);
    return Number(result.changes) > 0;
  }

  /**
   * Reclaim runs whose owner is gone, leaving live peers alone.
   *
   * `now` absent keeps the old behaviour — take every running run — which is
   * what a single instance restarting after a crash wants. With `now`, a run
   * is only reclaimed when its lease has expired or it never had one, so an
   * instance booting beside a working peer no longer re-executes its work.
   */
  async interruptRunning(
    now?: string,
    instanceId?: string,
  ): Promise<WorkflowRunRecord[]> {
    if (now) {
      // A run this instance owns is always reclaimable: reaching recovery means
      // this process restarted, so it is definitionally not executing anything,
      // and its own lease may well still look valid for the rest of the TTL.
      // Waiting that out would stall every crash recovery by the lease length.
      // Another instance's run is only taken once its lease lapses.
      this.db
        .prepare(
          `UPDATE workflow_runs SET status = 'interrupted'
           WHERE status = 'running'
             AND (lease_expires_at IS NULL
                  OR lease_expires_at < ?
                  OR instance_id = ?)`,
        )
        .run(now, instanceId ?? '');
    } else {
      this.db
        .prepare(
          `UPDATE workflow_runs SET status = 'interrupted'
           WHERE status = 'running'`,
        )
        .run();
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM workflow_runs WHERE status = 'interrupted'
           ORDER BY started_at`,
        )
        .all() as Row[]
    ).map(workflowRun);
  }
}

class SqliteEventStore implements EventStore {
  constructor(private readonly db: DatabaseSync) {}

  async append(event: NewRunEvent): Promise<RunEvent> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
           FROM run_events WHERE workflow_run_id = ?`,
        )
        .get(event.workflowRunId) as Row;
      const seq = Number(row.seq);
      this.db
        .prepare(
          `INSERT INTO run_events(
            workflow_run_id, seq, at, type, pipeline_id, pipe_id, message, data_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.workflowRunId,
          seq,
          event.at,
          event.type,
          event.pipelineId ?? null,
          event.pipeId ?? null,
          event.message ?? null,
          event.data ? JSON.stringify(event.data) : null,
        );
      this.db.exec('COMMIT');
      return { ...event, seq };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async list(workflowRunId: string, afterSeq = 0): Promise<RunEvent[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM run_events
           WHERE workflow_run_id = ? AND seq > ? ORDER BY seq`,
        )
        .all(workflowRunId, afterSeq) as Row[]
    ).map(runEvent);
  }
}

class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly db: DatabaseSync) {}

  async put(checkpoint: Checkpoint): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO checkpoints(
          workflow_run_id, pipeline_id, pipe_id, partition_id, cursor_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_run_id, pipeline_id, pipe_id, partition_id)
        DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`,
      )
      .run(
        checkpoint.workflowRunId,
        checkpoint.pipelineId,
        checkpoint.pipeId,
        checkpoint.partitionId,
        JSON.stringify(checkpoint.cursor),
        checkpoint.updatedAt,
      );
  }

  async get(
    workflowRunId: string,
    pipelineId: string,
    pipeId: string,
    partitionId: string,
  ): Promise<Checkpoint | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM checkpoints WHERE
          workflow_run_id = ? AND pipeline_id = ? AND pipe_id = ? AND partition_id = ?`,
      )
      .get(workflowRunId, pipelineId, pipeId, partitionId) as Row | undefined;
    return row ? checkpoint(row) : undefined;
  }

  async list(workflowRunId: string): Promise<Checkpoint[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM checkpoints
           WHERE workflow_run_id = ? ORDER BY pipeline_id, pipe_id, partition_id`,
        )
        .all(workflowRunId) as Row[]
    ).map(checkpoint);
  }
}

class SqliteTriggerScheduleStore implements TriggerScheduleStore {
  constructor(private readonly db: DatabaseSync) {}

  async put(state: TriggerScheduleState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO trigger_schedules(
          workflow_id, trigger_id, next_fire_at, last_accepted_at,
          schedule_fingerprint, seen_keys_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_id, trigger_id) DO UPDATE SET
          next_fire_at = excluded.next_fire_at,
          last_accepted_at = excluded.last_accepted_at,
          schedule_fingerprint = excluded.schedule_fingerprint,
          seen_keys_json = excluded.seen_keys_json`,
      )
      .run(
        state.workflowId,
        state.triggerId,
        state.nextFireAt,
        state.lastAcceptedAt ?? null,
        state.scheduleFingerprint ?? null,
        state.seenKeys ? JSON.stringify(state.seenKeys) : null,
      );
  }

  async get(
    workflowId: string,
    triggerId: string,
  ): Promise<TriggerScheduleState | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM trigger_schedules
         WHERE workflow_id = ? AND trigger_id = ?`,
      )
      .get(workflowId, triggerId) as Row | undefined;
    return row ? triggerSchedule(row) : undefined;
  }

  async list(): Promise<TriggerScheduleState[]> {
    return (
      this.db
        .prepare(
          'SELECT * FROM trigger_schedules ORDER BY next_fire_at, workflow_id, trigger_id',
        )
        .all() as Row[]
    ).map(triggerSchedule);
  }

  async remove(workflowId: string, triggerId: string): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM trigger_schedules WHERE workflow_id = ? AND trigger_id = ?',
      )
      .run(workflowId, triggerId);
  }
}

export interface SqliteStores {
  workflows: WorkflowStore;
  runs: RunStore;
  events: EventStore;
  checkpoints: CheckpointStore;
  schedules: TriggerScheduleStore;
  credentials: CredentialStore;
  environments: EnvironmentStore;
  variables: VariableStore;
  humanInputs: HumanInputStore;
  close(): void;
}

class SqliteEnvironmentStore implements EnvironmentStore {
  constructor(private readonly db: DatabaseSync) {}

  async list(): Promise<EnvironmentRecord[]> {
    return (
      this.db.prepare('SELECT * FROM environments ORDER BY name').all() as Row[]
    ).map(environment);
  }

  async get(id: string): Promise<EnvironmentRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM environments WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? environment(row) : undefined;
  }

  async getByName(name: string): Promise<EnvironmentRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM environments WHERE name = ?')
      .get(name) as Row | undefined;
    return row ? environment(row) : undefined;
  }

  async active(): Promise<EnvironmentRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM environments WHERE is_active = 1')
      .get() as Row | undefined;
    return row ? environment(row) : undefined;
  }

  async create(input: {
    name: string;
    isActive?: boolean;
  }): Promise<EnvironmentRecord> {
    const now = new Date().toISOString();
    const record: EnvironmentRecord = {
      id: randomUUID(),
      name: input.name,
      // First environment created becomes active, so a fresh install can run
      // without an explicit activation step.
      isActive: input.isActive ?? !this.db
        .prepare('SELECT 1 FROM environments LIMIT 1')
        .get(),
      createdAt: now,
      updatedAt: now,
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (record.isActive) {
        this.db.prepare('UPDATE environments SET is_active = 0').run();
      }
      this.db
        .prepare(
          `INSERT INTO environments(id, name, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.name,
          record.isActive ? 1 : 0,
          record.createdAt,
          record.updatedAt,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return record;
  }

  async rename(id: string, name: string): Promise<EnvironmentRecord | undefined> {
    this.db
      .prepare('UPDATE environments SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, new Date().toISOString(), id);
    return this.get(id);
  }

  async activate(id: string): Promise<EnvironmentRecord | undefined> {
    // Deactivate-then-activate in one transaction: the partial unique index
    // rejects a moment with two actives.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE environments SET is_active = 0').run();
      this.db
        .prepare(
          'UPDATE environments SET is_active = 1, updated_at = ? WHERE id = ?',
        )
        .run(new Date().toISOString(), id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = this.db
      .prepare('DELETE FROM environments WHERE id = ?')
      .run(id);
    return Number(result.changes) > 0;
  }
}

class SqliteVariableStore implements VariableStore {
  constructor(private readonly db: DatabaseSync) {}

  async list(filter?: {
    environmentId?: string;
    scope?: VariableScope;
    workflowId?: string;
  }): Promise<VariableRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter?.environmentId) {
      clauses.push('environment_id = ?');
      values.push(filter.environmentId);
    }
    if (filter?.scope) {
      clauses.push('scope = ?');
      values.push(filter.scope);
    }
    if (filter?.workflowId !== undefined) {
      clauses.push('workflow_id = ?');
      values.push(filter.workflowId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM variables${where} ORDER BY key`)
      .all(...(values as never[])) as Row[];
    return rows.map(variable);
  }

  async put(input: {
    environmentId: string;
    scope: VariableScope;
    workflowId?: string;
    key: string;
    value: unknown;
  }): Promise<VariableRecord> {
    const workflowId = input.scope === 'workflow' ? (input.workflowId ?? '') : '';
    if (input.scope === 'workflow' && !workflowId) {
      throw new Error('workflow-scoped variable requires a workflowId');
    }
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO variables(
           id, environment_id, scope, workflow_id, key, value_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(environment_id, scope, workflow_id, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        input.environmentId,
        input.scope,
        workflowId,
        input.key,
        JSON.stringify(input.value ?? null),
        updatedAt,
      );
    const row = this.db
      .prepare(
        `SELECT * FROM variables
         WHERE environment_id = ? AND scope = ? AND workflow_id = ? AND key = ?`,
      )
      .get(input.environmentId, input.scope, workflowId, input.key) as Row;
    return variable(row);
  }

  async remove(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM variables WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  async resolve(
    environmentId: string,
    workflowId: string,
  ): Promise<Record<string, unknown>> {
    // One query, globals first: ordering by scope ('global' < 'workflow')
    // means workflow-local rows overwrite globals of the same key.
    const rows = this.db
      .prepare(
        `SELECT key, value_json FROM variables
         WHERE environment_id = ? AND (workflow_id = '' OR workflow_id = ?)
         ORDER BY scope`,
      )
      .all(environmentId, workflowId) as Row[];
    const resolved: Record<string, unknown> = {};
    for (const row of rows) {
      resolved[String(row.key)] = JSON.parse(String(row.value_json)) as unknown;
    }
    return resolved;
  }
}

class SqliteHumanInputStore implements HumanInputStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
  ) {}

  async request(input: {
    workflowRunId: string;
    pipelineId: string;
    pipeId: string;
    request: HumanInputRequest;
    now: string;
  }): Promise<HumanInputRecord> {
    const existing = await this.get(input.workflowRunId, input.request.key);
    // Re-asking is the normal path, not an error: the pipe runs again on every
    // resume attempt. Returning the original keeps one question, one deadline.
    if (existing && existing.status === 'pending') return existing;

    const expiresAt = new Date(
      new Date(input.now).getTime() + input.request.expiresInSeconds * 1000,
    ).toISOString();
    const id = `hi_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO human_inputs
           (id, workflow_run_id, pipeline_id, pipe_id, key, request_json,
            status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(workflow_run_id, key) DO UPDATE SET
           status = 'pending',
           request_json = excluded.request_json,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           answered_at = NULL,
           answer_encrypted = NULL`,
      )
      .run(
        id,
        input.workflowRunId,
        input.pipelineId,
        input.pipeId,
        input.request.key,
        JSON.stringify(input.request),
        input.now,
        expiresAt,
      );
    const created = await this.get(input.workflowRunId, input.request.key);
    if (!created) throw new Error('human input request was not stored');
    return created;
  }

  async pending(workflowRunId: string): Promise<HumanInputRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM human_inputs
          WHERE workflow_run_id = ? AND status = 'pending'
          ORDER BY created_at`,
      )
      .all(workflowRunId) as Row[];
    return rows.map(humanInput);
  }

  async get(
    workflowRunId: string,
    key: string,
  ): Promise<HumanInputRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM human_inputs WHERE workflow_run_id = ? AND key = ?')
      .get(workflowRunId, key) as Row | undefined;
    return row ? humanInput(row) : undefined;
  }

  async answer(
    workflowRunId: string,
    key: string,
    values: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const result = this.db
      .prepare(
        `UPDATE human_inputs
            SET status = 'answered', answered_at = ?, answer_encrypted = ?
          WHERE workflow_run_id = ? AND key = ? AND status = 'pending'`,
      )
      .run(now, encrypt(JSON.stringify(values), this.key), workflowRunId, key);
    // Guarded by status so answering twice, or answering something already
    // expired, is refused here rather than silently resuming a dead run.
    if (result.changes === 0) {
      throw new Error(`no pending human input for ${workflowRunId}/${key}`);
    }
  }

  async answerFor(
    workflowRunId: string,
    key: string,
  ): Promise<Record<string, unknown> | undefined> {
    const row = this.db
      .prepare(
        `SELECT answer_encrypted FROM human_inputs
          WHERE workflow_run_id = ? AND key = ? AND status = 'answered'`,
      )
      .get(workflowRunId, key) as Row | undefined;
    const payload = row?.answer_encrypted;
    if (typeof payload !== 'string' || !payload) return undefined;
    return JSON.parse(decrypt(payload, this.key)) as Record<string, unknown>;
  }

  async expire(now: string): Promise<HumanInputRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM human_inputs
          WHERE status = 'pending' AND expires_at <= ?`,
      )
      .all(now) as Row[];
    if (rows.length > 0) {
      this.db
        .prepare(
          `UPDATE human_inputs SET status = 'expired'
            WHERE status = 'pending' AND expires_at <= ?`,
        )
        .run(now);
    }
    return rows.map((row) => ({ ...humanInput(row), status: 'expired' as const }));
  }
}

function humanInput(row: Row): HumanInputRecord {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    pipelineId: String(row.pipeline_id),
    pipeId: String(row.pipe_id),
    request: JSON.parse(String(row.request_json)) as HumanInputRequest,
    status: String(row.status) as HumanInputRecord['status'],
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    ...(row.answered_at ? { answeredAt: String(row.answered_at) } : {}),
  };
}

/**
 * `db` with `prepare` memoised by SQL text.
 *
 * Every store method prepares its statement on each call, and compiling the
 * SQL is most of what a small query costs: an event append or a checkpoint
 * write paid for it on every batch of every run. A statement is reusable once
 * its call returns, and nothing here holds one open across an `iterate()`.
 * The set of statements is fixed by the code, so the cache is bounded.
 */
function withStatementCache(db: DatabaseSync): DatabaseSync {
  const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  return db;
}

export function openSqliteStores(
  filename: string,
  encryptionKey: Buffer,
  options: {
    resolveFoxSchemaConnection?: (
      connectionId: string,
    ) => Promise<Record<string, unknown> | undefined>;
  } = {},
): SqliteStores {
  const db = withStatementCache(new DatabaseSync(filename));
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db, encryptionKey);
  return {
    workflows: new SqliteWorkflowStore(db),
    runs: new SqliteRunStore(db, encryptionKey),
    events: new SqliteEventStore(db),
    checkpoints: new SqliteCheckpointStore(db),
    schedules: new SqliteTriggerScheduleStore(db),
    credentials: new SqliteCredentialStore(
      db,
      encryptionKey,
      options.resolveFoxSchemaConnection,
    ),
    environments: new SqliteEnvironmentStore(db),
    variables: new SqliteVariableStore(db),
    humanInputs: new SqliteHumanInputStore(db, encryptionKey),
    close(): void {
      db.close();
    },
  };
}

function environment(row: Row): EnvironmentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    isActive: Number(row.is_active) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function variable(row: Row): VariableRecord {
  const workflowId = String(row.workflow_id);
  return {
    id: String(row.id),
    environmentId: String(row.environment_id),
    scope: String(row.scope) as VariableScope,
    ...(workflowId ? { workflowId } : {}),
    key: String(row.key),
    value: JSON.parse(String(row.value_json)) as unknown,
    updatedAt: String(row.updated_at),
  };
}

function json<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function idempotencyHash(value: string, key: Buffer): string {
  return `h1:${createHmac('sha256', key).update(value).digest('hex')}`;
}

function optional(row: Row, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : String(value);
}

function credentialMeta(row: Row): CredentialMeta {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as CredentialMeta['kind'],
    source: (row.source ? String(row.source) : 'local') as CredentialMeta['source'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The columns {@link workflowRun} reads. Not `*`: every run row also carries
 * the workflow snapshot it ran and its encrypted invocation, which are the
 * largest values in the table and which nothing listing runs needs.
 */
const RUN_COLUMNS = [
  'id',
  'workflow_id',
  'workflow_version',
  'status',
  'trigger',
  'trigger_id',
  'started_at',
  'finished_at',
  'error',
  'instance_id',
  'parent_run_id',
  'environment_id',
  'variables_json',
  'debug',
].join(', ');

function workflowRun(row: Row): WorkflowRunRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    workflowVersion: Number(row.workflow_version),
    status: String(row.status) as WorkflowRunRecord['status'],
    trigger: String(row.trigger),
    triggerId: optional(row, 'trigger_id'),
    startedAt: String(row.started_at),
    finishedAt: optional(row, 'finished_at'),
    error: optional(row, 'error'),
    instanceId: String(row.instance_id),
    parentRunId: optional(row, 'parent_run_id'),
    environmentId: optional(row, 'environment_id'),
    ...(row.variables_json
      ? {
          variables: JSON.parse(String(row.variables_json)) as Record<
            string,
            unknown
          >,
        }
      : {}),
    ...(Number(row.debug) === 1 ? { debug: true } : {}),
  };
}

function pipelineRun(row: Row): PipelineRunRecord {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    pipelineId: String(row.pipeline_id),
    status: String(row.status) as PipelineRunRecord['status'],
    startedAt: optional(row, 'started_at'),
    finishedAt: optional(row, 'finished_at'),
    error: optional(row, 'error'),
  };
}

function pipeRun(row: Row): PipeRunRecord {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    pipelineId: String(row.pipeline_id),
    pipeId: String(row.pipe_id),
    status: String(row.status) as PipeRunRecord['status'],
    attempt: Number(row.attempt),
    processedBatches: Number(row.processed_batches),
    processedRecords: Number(row.processed_records),
    startedAt: optional(row, 'started_at'),
    finishedAt: optional(row, 'finished_at'),
    error: optional(row, 'error'),
  };
}

function runEvent(row: Row): RunEvent {
  return {
    seq: Number(row.seq),
    workflowRunId: String(row.workflow_run_id),
    at: String(row.at),
    type: String(row.type) as RunEvent['type'],
    pipelineId: optional(row, 'pipeline_id'),
    pipeId: optional(row, 'pipe_id'),
    message: optional(row, 'message'),
    data: row.data_json ? json<Record<string, unknown>>(row.data_json) : undefined,
  };
}

function checkpoint(row: Row): Checkpoint {
  return {
    workflowRunId: String(row.workflow_run_id),
    pipelineId: String(row.pipeline_id),
    pipeId: String(row.pipe_id),
    partitionId: String(row.partition_id),
    cursor: json<Record<string, unknown>>(row.cursor_json),
    updatedAt: String(row.updated_at),
  };
}

function triggerSchedule(row: Row): TriggerScheduleState {
  return {
    workflowId: String(row.workflow_id),
    triggerId: String(row.trigger_id),
    nextFireAt: String(row.next_fire_at),
    lastAcceptedAt: optional(row, 'last_accepted_at'),
    scheduleFingerprint: optional(row, 'schedule_fingerprint'),
    seenKeys: parseSeenKeys(row.seen_keys_json),
  };
}

/**
 * A corrupt cursor must not wedge the schedule. Returning undefined replays
 * the "never polled" path, which `onFirstPoll` handles — at worst one batch is
 * re-delivered, versus a trigger that throws on every tick forever.
 */
function parseSeenKeys(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}
