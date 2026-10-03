import { api, type RequestOptions } from '@/shared/api/client';

export type MigrationRunStatus = 'RUNNING' | 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'ROLLED_BACK';

export interface MigrationObjectResult {
  name: string;
  type: string;
  action: string;
  status: string;
  error?: string;
}

export interface MigrationRunSummary {
  id: string;
  status: MigrationRunStatus;
  dialect: string;
  host?: string;
  database?: string;
  schema?: string;
  objectCount: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** The committed migration this run applied, when it came from Git. */
  git?: { repoId: string; branch?: string; commit: string; path: string };
}

export interface MigrationRunDetail extends MigrationRunSummary {
  script?: string;
  snapshotDdl?: string;
  results: MigrationObjectResult[];
}

/** These routes predate the shared client and tolerate an empty reply; keep that. */
const EMPTY_OK: RequestOptions = { allowEmpty: true };

export async function apiListMigrations(): Promise<MigrationRunSummary[]> {
  const { runs } = await api.get<{ runs: MigrationRunSummary[] }>('/migrations', EMPTY_OK);
  return runs;
}

export async function apiGetMigration(id: string): Promise<MigrationRunDetail> {
  const { run } = await api.get<{ run: MigrationRunDetail }>(`/migrations/${id}`, EMPTY_OK);
  return run;
}

export async function apiDeleteMigration(id: string): Promise<void> {
  await api.delete(`/migrations/${id}`, undefined, EMPTY_OK);
}

/** Delete a set of runs. Returns how many were removed. */
export async function apiDeleteMigrations(ids: string[]): Promise<number> {
  const { removed } = await api.post<{ removed: number }>('/migrations/delete', { ids }, EMPTY_OK);
  return removed;
}

/** Clear the entire migration history. Returns how many were removed. */
export async function apiClearMigrations(): Promise<number> {
  const { removed } = await api.delete<{ removed: number }>('/migrations', undefined, EMPTY_OK);
  return removed;
}
