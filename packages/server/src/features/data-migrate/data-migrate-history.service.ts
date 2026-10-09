/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-user log of SQL Editor data-migrate runs (row ops from side-by-side compare).
 * Separate from Schema Sync `migration_runs`.
 */
import type { WorkspaceScope } from '../../platform/http/scope';
import { randomUUID } from 'node:crypto';
import { getStore } from '../../database/store';
import { HISTORY_MAX_TEXT_LEN, truncateForDisplay } from '../../database/stored-text';

export type DataMigrateRunStatus =
  | 'RUNNING'
  | 'SUCCESS'
  | 'PARTIAL_SUCCESS'
  | 'FAILED';

export interface DataMigrateOpResult {
  op: 'insert' | 'update' | 'delete';
  key: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  error?: string;
}

export interface DataMigrateRunSummary {
  id: string;
  status: DataMigrateRunStatus;
  dialect: string;
  sourceHost?: string;
  targetHost?: string;
  database?: string;
  schema?: string;
  tableName?: string;
  rowCount: number;
  opsEnabled: { insert: boolean; update: boolean; delete: boolean };
  includeIdentity: boolean;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface DataMigrateRunDetail extends DataMigrateRunSummary {
  script?: string;
  snapshotJson?: string;
  keyColumns: string[];
  results: DataMigrateOpResult[];
}

interface Row {
  id: string;
  status: string;
  dialect: string;
  source_host: string | null;
  target_host: string | null;
  database_name: string | null;
  schema: string | null;
  table_name: string | null;
  row_count: number;
  ops_json: string | null;
  include_identity: number;
  key_columns_json: string | null;
  script: string | null;
  snapshot_json: string | null;
  results_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const MAX_RUNS_PER_USER = 200;
/** Bound script / snapshot blobs so one run cannot bloat the metadata DB. */
export const DATA_MIGRATE_MAX_TEXT_LEN = HISTORY_MAX_TEXT_LEN;

/**
 * Store snapshot JSON only when it fits intact. Appending a truncation marker
 * (the old `cap()` behavior) produced invalid JSON, so History still offered
 * Restore while `JSON.parse` always failed — a silent loss of the undo safety net.
 */
export function storeableSnapshotJson(
  text: string | undefined,
  max = DATA_MIGRATE_MAX_TEXT_LEN
): { json: string | undefined; stored: boolean } {
  if (text == null) return { json: undefined, stored: false };
  if (text.length > max) return { json: undefined, stored: false };
  try {
    JSON.parse(text);
  } catch {
    return { json: undefined, stored: false };
  }
  return { json: text, stored: true };
}

function parseOps(raw: string | null): { insert: boolean; update: boolean; delete: boolean } {
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      insert: Boolean(o.insert),
      update: Boolean(o.update),
      delete: Boolean(o.delete),
    };
  } catch {
    return { insert: false, update: false, delete: false };
  }
}

export class DataMigrateHistoryStore {
  async start(
    scope: WorkspaceScope,
    input: {
      dialect: string;
      sourceHost?: string;
      targetHost?: string;
      database?: string;
      schema?: string;
      tableName?: string;
      rowCount: number;
      opsEnabled: { insert: boolean; update: boolean; delete: boolean };
      includeIdentity: boolean;
      keyColumns: string[];
      script: string;
      snapshotJson?: string;
    }
  ): Promise<{ id: string; snapshotStored: boolean }> {
    const id = randomUUID();
    const snapshot = storeableSnapshotJson(input.snapshotJson);
    const store = await getStore();
    await store.run(
      `INSERT INTO data_migrate_runs
         (id, user_id, workspace_id, status, dialect, source_host, target_host, database_name, "schema",
          table_name, row_count, ops_json, include_identity, key_columns_json, script, snapshot_json, started_at)
       VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        scope.userId,
        scope.workspaceId,
        input.dialect,
        input.sourceHost ?? null,
        input.targetHost ?? null,
        input.database ?? null,
        input.schema ?? null,
        input.tableName ?? null,
        input.rowCount,
        JSON.stringify(input.opsEnabled),
        input.includeIdentity ? 1 : 0,
        JSON.stringify(input.keyColumns),
        truncateForDisplay(input.script) ?? null,
        snapshot.json ?? null,
        new Date().toISOString(),
      ]
    );
    await this.prune(scope);
    return { id, snapshotStored: snapshot.stored };
  }

  private async prune(scope: WorkspaceScope): Promise<void> {
    const store = await getStore();
    await store.run(
      `DELETE FROM data_migrate_runs
        WHERE workspace_id = ?
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM data_migrate_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?
            ) AS keep
          )`,
      [scope.workspaceId, scope.workspaceId, MAX_RUNS_PER_USER]
    );
  }

  async finish(
    id: string,
    outcome: {
      status: DataMigrateRunStatus;
      results: DataMigrateOpResult[];
      error?: string;
    }
  ): Promise<void> {
    const store = await getStore();
    await store.run(
      `UPDATE data_migrate_runs
          SET status = ?, results_json = ?, error = ?, finished_at = ?
        WHERE id = ?`,
      [
        outcome.status,
        JSON.stringify(outcome.results ?? []),
        outcome.error ?? null,
        new Date().toISOString(),
        id,
      ]
    );
  }

  private summary(r: Row): DataMigrateRunSummary {
    return {
      id: r.id,
      status: r.status as DataMigrateRunStatus,
      dialect: r.dialect,
      sourceHost: r.source_host ?? undefined,
      targetHost: r.target_host ?? undefined,
      database: r.database_name ?? undefined,
      schema: r.schema ?? undefined,
      tableName: r.table_name ?? undefined,
      rowCount: r.row_count,
      opsEnabled: parseOps(r.ops_json),
      includeIdentity: Boolean(r.include_identity),
      error: r.error ?? undefined,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
    };
  }

  async list(scope: WorkspaceScope, limit = 100): Promise<DataMigrateRunSummary[]> {
    const store = await getStore();
    const rows = await store.all<Row>(
      `SELECT id, status, dialect, source_host, target_host, database_name, "schema", table_name,
              row_count, ops_json, include_identity, error, started_at, finished_at
         FROM data_migrate_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?`,
      [scope.workspaceId, limit]
    );
    return rows.map((r) => this.summary(r));
  }

  async get(scope: WorkspaceScope, id: string): Promise<DataMigrateRunDetail | null> {
    const store = await getStore();
    const r = await store.get<Row>(
      'SELECT * FROM data_migrate_runs WHERE id = ? AND workspace_id = ?',
      [id, scope.workspaceId]
    );
    if (!r) return null;
    let results: DataMigrateOpResult[] = [];
    let keyColumns: string[] = [];
    try {
      results = r.results_json ? (JSON.parse(r.results_json) as DataMigrateOpResult[]) : [];
    } catch {
      /* ignore */
    }
    try {
      keyColumns = r.key_columns_json
        ? (JSON.parse(r.key_columns_json) as string[])
        : [];
    } catch {
      /* ignore */
    }
    return {
      ...this.summary(r),
      script: r.script ?? undefined,
      snapshotJson: r.snapshot_json ?? undefined,
      keyColumns,
      results,
    };
  }

  async remove(scope: WorkspaceScope, id: string): Promise<boolean> {
    const store = await getStore();
    const result = await store.run(
      'DELETE FROM data_migrate_runs WHERE id = ? AND workspace_id = ?',
      [id, scope.workspaceId]
    );
    return result.changes > 0;
  }

  async clear(scope: WorkspaceScope): Promise<number> {
    const store = await getStore();
    const result = await store.run('DELETE FROM data_migrate_runs WHERE workspace_id = ?', [
      scope.workspaceId,
    ]);
    return result.changes;
  }
}
