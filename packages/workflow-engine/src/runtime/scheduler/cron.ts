/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/runtime/src/scheduler/cron.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  CredentialStore,
  TriggerInvocation,
  TriggerScheduleStore,
  WorkflowDef,
  WorkflowStore,
} from '../../common/index.js';
import { parseDurationMs } from '../../common/index.js';
import { executeHttpRequest } from '../../pipes/http/index.js';
import {
  connectionFromSecret,
  runSqlScript,
  type RunSqlScriptOptions,
  type SqlConnection,
} from '../../pipes/db/sql.js';
import { CronExpressionParser } from 'cron-parser';

interface CronScheduler {
  enqueue(workflow: WorkflowDef, invocation: TriggerInvocation): Promise<unknown>;
}

export interface CronCoordinatorOptions {
  workflows: WorkflowStore;
  schedules: TriggerScheduleStore;
  scheduler: CronScheduler;
  /** Required for `executionType: 'http'` credential auth and for `executionType: 'sql'`. */
  credentials?: CredentialStore;
  fetch?: typeof fetch;
  /**
   * Runs a SQL schedule's script and hands the last statement's rows to
   * `beforeCommit`. Defaults to FoxSchema's own drivers; a test answers
   * without a database.
   */
  runSql?: CronSqlRunner;
  now?: () => Date;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

/** Runs a SQL schedule's script; see `CronCoordinatorOptions.runSql`. */
export type CronSqlRunner = (
  connection: SqlConnection,
  script: string,
  options: Required<Pick<RunSqlScriptOptions, 'transaction' | 'connect' | 'beforeCommit'>>,
) => Promise<unknown>;

export class CronCoordinator {
  private timer?: ReturnType<typeof setInterval>;
  /** SQL schedules whose previous fire is still running, by workflow and trigger. */
  private readonly sqlInFlight = new Set<string>();
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;

  private readonly onError: (error: unknown) => void;

  constructor(private readonly options: CronCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    // Nothing-silent: fire failures (especially detached HTTP fires) must
    // surface somewhere even when no embedder wires onError.
    this.onError =
      options.onError ??
      ((error) => console.error('[workflow-engine] cron fire failed:', error));
  }

  async recover(): Promise<void> {
    await this.process(true);
  }

  async tick(): Promise<void> {
    await this.process(false);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.onError(error));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async process(recovering: boolean): Promise<void> {
    const now = this.now();
    // One read of each per tick. Reading a schedule per trigger made a tick
    // cost a query for every cron trigger in the installation.
    const [workflows, states] = await Promise.all([
      this.options.workflows.list(),
      this.options.schedules.list(),
    ]);
    const stateByKey = new Map(
      states.map((state) => [`${state.workflowId}\0${state.triggerId}`, state]),
    );
    const active = new Set<string>();

    for (const workflow of workflows) {
      for (const trigger of workflow.triggers) {
        if (trigger.kind !== 'cron' || !trigger.enabled) continue;
        const key = `${workflow.id}\0${trigger.id}`;
        const fingerprint = scheduleFingerprint(trigger);
        active.add(key);
        const state = stateByKey.get(key);
        if (!state || state.scheduleFingerprint !== fingerprint) {
          await this.options.schedules.put({
            workflowId: workflow.id,
            triggerId: trigger.id,
            nextFireAt: nextOccurrence(trigger, now),
            scheduleFingerprint: fingerprint,
          });
          continue;
        }
        if (new Date(state.nextFireAt).getTime() > now.getTime()) continue;

        const due = dueOccurrences(trigger, state.nextFireAt, now);
        const accepted = acceptedOccurrences(trigger, due, recovering);
        if (trigger.executionType === 'sql') {
          this.fireSql(workflow, trigger, accepted, now);
        } else {
          for (const scheduledAt of accepted) {
            try {
              await this.fire(workflow, trigger, scheduledAt, now);
            } catch (error) {
              this.onError(error);
            }
          }
        }
        const nextFireAt =
          trigger.catchUp === 'all' && accepted.length > 0
            ? nextOccurrence(
                trigger,
                new Date(accepted[accepted.length - 1]!),
              )
            : nextOccurrence(trigger, now);
        await this.options.schedules.put({
          workflowId: workflow.id,
          triggerId: trigger.id,
          nextFireAt,
          lastAcceptedAt: accepted.at(-1) ?? state.lastAcceptedAt,
          scheduleFingerprint: fingerprint,
        });
      }
    }

    // Reap rows for triggers that are gone or disabled — deleting a schedule
    // means re-enabling starts clean rather than resuming a stale nextFireAt.
    //
    // Scope is every *enabled* trigger, not just this coordinator's cron ones
    // (`active`): the table is shared trigger state, and reaping by `active`
    // would delete a row another trigger kind keeps there.
    const live = new Set(
      workflows.flatMap((workflow) =>
        workflow.triggers
          .filter((trigger) => trigger.enabled)
          .map((trigger) => `${workflow.id}\0${trigger.id}`),
      ),
    );
    // Rows written during this tick are for live triggers, so the list read at
    // the start is all this needs.
    for (const state of states) {
      if (!live.has(`${state.workflowId}\0${state.triggerId}`)) {
        await this.options.schedules.remove(state.workflowId, state.triggerId);
      }
    }
  }

  private async fire(
    workflow: WorkflowDef,
    trigger: CronTrigger,
    scheduledAt: string,
    now: Date,
  ): Promise<void> {
    if (trigger.executionType === 'http') {
      // Detached: the retry backoff can sleep for minutes (retryConfig), and
      // process() is the single scheduling tick — one failing endpoint must
      // not stall every other schedule. Failures still reach onError, and
      // nextFireAt advances the same way it does when fireHttp throws inline.
      void this.fireHttp(trigger, scheduledAt).catch((error) =>
        this.onError(error),
      );
      return;
    }

    await this.options.scheduler.enqueue(
      workflow,
      cronInvocation(workflow.id, trigger.id, scheduledAt, now),
    );
  }

  /**
   * Detached for the same reason as HTTP: a slow query must not stall the
   * tick for every other schedule. The occurrences one tick accepts (several
   * with `catchUp: 'all'`) run one after another. A fire that comes due while
   * the previous series still runs is skipped: two copies of a script that
   * moves rows would race over the same rows.
   */
  private fireSql(
    workflow: WorkflowDef,
    trigger: CronTrigger,
    occurrences: string[],
    now: Date,
  ): void {
    if (occurrences.length === 0) return;
    const key = `${workflow.id}\0${trigger.id}`;
    if (this.sqlInFlight.has(key)) {
      this.onError(
        new Error(
          `cron SQL ${trigger.id} at ${occurrences.join(', ')} skipped: the previous run of its script has not finished`,
        ),
      );
      return;
    }
    this.sqlInFlight.add(key);
    void (async () => {
      for (const scheduledAt of occurrences) {
        try {
          await this.runSqlOccurrence(workflow, trigger, scheduledAt, now);
        } catch (error) {
          this.onError(error);
        }
      }
    })().finally(() => this.sqlInFlight.delete(key));
  }

  /**
   * Run the schedule's script, then start the workflow with the rows. With
   * `onlyWhenRows` (the default) an empty result creates no run at all.
   *
   * The run is enqueued before the script's transaction commits, so a run
   * that cannot start rolls the script back instead of losing the rows it
   * moved. Retries cover connecting only: once a statement has been sent,
   * running the script again could repeat writes that already happened.
   */
  private async runSqlOccurrence(
    workflow: WorkflowDef,
    trigger: CronTrigger,
    scheduledAt: string,
    now: Date,
  ): Promise<void> {
    const sql = trigger.sql;
    if (!sql) {
      throw new Error(
        `cron trigger ${trigger.id}: sql config required for executionType sql`,
      );
    }
    const credentials = this.options.credentials;
    if (!credentials) {
      throw new Error(
        `cron SQL ${trigger.id}: no credential store is wired into the scheduler`,
      );
    }
    const runSql: CronSqlRunner =
      this.options.runSql ??
      ((connection, script, options) => runSqlScript(connection, script, options));

    // Kind must match, as for webhooks: an HTTP or webhook secret has no
    // business being handed to a database driver.
    const meta = await credentials.get(sql.credentialId);
    if (!meta || meta.kind !== 'database') {
      throw new Error(
        `cron SQL ${trigger.id}: ${sql.credentialId} is not a database credential`,
      );
    }
    const secret = await credentials.revealSecret(sql.credentialId);
    if (!secret) {
      throw new Error(
        `cron SQL ${trigger.id}: credential not found: ${sql.credentialId}`,
      );
    }
    const connection = connectionFromSecret(secret, sql.credentialId, sql);
    await runSql(connection, sql.script, {
      transaction: sql.transaction,
      connect: (open) => withRetry(trigger, open),
      beforeCommit: async (rows) => {
        if (sql.onlyWhenRows && rows.length === 0) return;
        const kept = rows.slice(0, sql.maxRows);
        const invocation = cronInvocation(workflow.id, trigger.id, scheduledAt, now);
        invocation.payload = {
          scheduledAt,
          rowCount: rows.length,
          ...(rows.length > kept.length ? { truncated: true } : {}),
          rows: kept,
        };
        const result = await this.options.scheduler.enqueue(workflow, invocation);
        const refusal = refusedEnqueue(result);
        if (refusal) {
          throw new Error(
            `cron SQL ${trigger.id} at ${scheduledAt}: the run was not started (${refusal})`,
          );
        }
      },
    });
  }

  private async fireHttp(
    trigger: CronTrigger,
    scheduledAt: string,
  ): Promise<void> {
    if (!trigger.http) {
      throw new Error(
        `cron trigger ${trigger.id}: http config required for executionType http`,
      );
    }
    const http = trigger.http;
    await withRetry(trigger, async () => {
      const credentialId =
        http.auth.type === 'credential' ? http.auth.credentialId : undefined;
      const secret = await resolveRequestSecret(http, this.options.credentials);
      const result = await executeHttpRequest({
        request: http,
        secret,
        credentialId,
        credentials: this.options.credentials,
        variables: http.variables,
        trigger: { scheduledAt, triggerId: trigger.id, kind: 'cron' },
        fetch: this.options.fetch,
      });
      if (!result.ok) {
        throw new Error(
          `cron HTTP ${trigger.id} at ${scheduledAt} returned ${result.status}`,
        );
      }
    });
  }
}

/** `work`, retried with the schedule's backoff when it has a retry policy. */
async function withRetry<T>(
  trigger: CronTrigger,
  work: () => Promise<T>,
): Promise<T> {
  const attempts = (trigger.retryConfig?.maxRetryAttempts ?? 0) + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) break;
      await sleep(backoffMs(trigger, attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Why the scheduler declined a run, when it reports `{ accepted: false }`. */
function refusedEnqueue(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const { accepted, reason, detail } = result as {
    accepted?: unknown;
    reason?: unknown;
    detail?: unknown;
  };
  if (accepted !== false) return undefined;
  return [reason, detail].filter((part) => typeof part === 'string' && part).join(': ') || 'refused';
}

type CronTrigger = Extract<
  WorkflowDef['triggers'][number],
  { kind: 'cron' }
>;

async function resolveRequestSecret(
  request: NonNullable<CronTrigger['http']>,
  credentials?: CredentialStore,
): Promise<Record<string, unknown> | undefined> {
  if (request.auth.type !== 'credential' || !credentials) return undefined;
  return credentials.revealSecret(request.auth.credentialId);
}

function acceptedOccurrences(
  trigger: CronTrigger,
  due: string[],
  recovering: boolean,
): string[] {
  if (recovering && trigger.catchUp === 'none') return [];
  if (trigger.catchUp === 'all') return due;
  return due.slice(0, 1);
}

function nextOccurrence(trigger: CronTrigger, currentDate: Date): string {
  return CronExpressionParser.parse(trigger.cron, {
    currentDate,
    tz: trigger.timezone,
  })
    .next()
    .toDate()
    .toISOString();
}

function scheduleFingerprint(trigger: CronTrigger): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cron: trigger.cron,
        timezone: trigger.timezone,
        executionType: trigger.executionType,
        http: trigger.http ?? null,
        // Only when set: adding a key for every trigger would change every
        // existing schedule's fingerprint, and a changed fingerprint
        // reschedules from now — dropping an occurrence that was due.
        ...(trigger.sql ? { sql: trigger.sql } : {}),
      }),
    )
    .digest('hex');
}

function dueOccurrences(
  trigger: CronTrigger,
  first: string,
  now: Date,
): string[] {
  const due = [first];
  let cursor = first;
  while (due.length < 100) {
    const next = nextOccurrence(trigger, new Date(cursor));
    if (new Date(next).getTime() > now.getTime()) break;
    due.push(next);
    cursor = next;
  }
  return due;
}

function cronInvocation(
  workflowId: string,
  triggerId: string,
  scheduledAt: string,
  acceptedAt: Date,
): TriggerInvocation {
  return {
    id: randomUUID(),
    workflowId,
    triggerId,
    kind: 'cron',
    acceptedAt: acceptedAt.toISOString(),
    payload: { scheduledAt },
    idempotencyKey: `cron:${scheduledAt}`,
    fingerprint: createHash('sha256').update(scheduledAt).digest('hex'),
    metadata: {},
  };
}

function backoffMs(trigger: CronTrigger, attempt: number): number {
  const retry = trigger.retryConfig;
  if (!retry) return 100;
  const min = parseDurationMs(retry.minBackoffDuration) ?? 5_000;
  const max = parseDurationMs(retry.maxBackoffDuration) ?? 3_600_000;
  const doublings = Math.min(attempt, retry.maxDoublings);
  return Math.min(min * 2 ** doublings, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
