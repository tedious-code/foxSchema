/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared DBA utility probes for /schema/dba-utility.
 */
import { ConnectionFactory, type ConnectionOptions } from '@foxschema/db';
import { buildDbaUtilityQuery, dialectSupportsDbaUtility, normalizeConnectionPoolRows, normalizeObjectSizeRows, normalizeSystemInfoRows, normalizeUserSessionRows, type ConnectionPoolInfo, type DbaUtilityKind, type DbaUtilitySupport, type ObjectSizeRow, type SystemInfoMetric, type UserSessionRow } from '@foxschema/features';
import { buildBlockingChains, buildLockWaitProbeQuery, buildSessionControlSql, buildTableHealthProbeQuery, buildTableMaintenanceSql, dbaPrivilegeRemedy, dialectSupportsSessionLocks, dialectSupportsTableMaintenance, normalizeLockWaitRows, normalizeTableHealthRows, type BlockingChain, type LockWaitRow, type SessionControlAction, type SessionLocksSupport, type TableHealthRow, type TableMaintenanceAction, type TableMaintenanceSupport } from '@foxschema/features';
import { redactCredentials } from '../../platform/http/redact';

export type DbaUtilityProbeSuccess = {
  kind: DbaUtilityKind;
  mode: 'native' | 'estimated' | 'unsupported';
  support: DbaUtilitySupport;
  pool?: ConnectionPoolInfo;
  sessions?: UserSessionRow[];
  system?: SystemInfoMetric;
  sizes?: ObjectSizeRow[];
  warning?: string;
};

export type DbaUtilityProbeFailure = {
  error: string;
  support: DbaUtilitySupport;
  status: number;
};

export async function probeDbaUtility(opts: {
  dialect: string;
  option: ConnectionOptions;
  kind: DbaUtilityKind;
  schema?: string;
}): Promise<
  { ok: true; value: DbaUtilityProbeSuccess } | { ok: false; failure: DbaUtilityProbeFailure }
> {
  const support = dialectSupportsDbaUtility(opts.dialect, opts.kind);
  if (!support.query) {
    return {
      ok: false,
      failure: {
        status: 400,
        error: support.hint || 'This dialect does not support this utility.',
        support,
      },
    };
  }

  const built = buildDbaUtilityQuery({
    dialect: opts.dialect,
    kind: opts.kind,
    schema: opts.schema,
  });
  if ('error' in built) {
    return {
      ok: false,
      failure: { status: 400, error: built.error, support },
    };
  }

  try {
    const raw = await ConnectionFactory.executeQuery<Record<string, unknown>>(
      opts.dialect,
      opts.option,
      built.sql,
      built.params
    );

    const base = {
      kind: opts.kind,
      mode: built.mode,
      support,
    };

    if (opts.kind === 'pool') {
      return { ok: true, value: { ...base, pool: normalizeConnectionPoolRows(raw) } };
    }
    if (opts.kind === 'sessions') {
      return { ok: true, value: { ...base, sessions: normalizeUserSessionRows(raw) } };
    }
    if (opts.kind === 'system') {
      return { ok: true, value: { ...base, system: normalizeSystemInfoRows(raw) } };
    }
    return { ok: true, value: { ...base, sizes: normalizeObjectSizeRows(raw) } };
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : 'DBA utility probe failed';
    const message = redactCredentials(rawMessage);
    // A privileged view refused is not a broken database, and the raw code says
    // the opposite — Oracle reports "table or view does not exist" for a view
    // the caller simply may not read. Where the engine's error is that shape,
    // answer with the grant instead of the hint describing what we attempted.
    const remedy = dbaPrivilegeRemedy(opts.dialect, opts.kind, rawMessage);
    return {
      ok: false,
      failure: {
        status: remedy ? 403 : 500,
        error: remedy ? `${message} — ${remedy}` : `${message} — ${support.hint}`,
        support,
      },
    };
  }
}

export async function probeSessionLocks(opts: {
  dialect: string;
  option: ConnectionOptions;
}): Promise<
  | { ok: true; value: { support: SessionLocksSupport; locks: LockWaitRow[]; chains: BlockingChain[] } }
  | { ok: false; failure: { status: number; error: string; support: SessionLocksSupport } }
> {
  const support = dialectSupportsSessionLocks(opts.dialect);
  if (!support.supported) {
    return { ok: false, failure: { status: 400, error: support.hint, support } };
  }
  const built = buildLockWaitProbeQuery(opts.dialect);
  if ('error' in built) {
    return { ok: false, failure: { status: 400, error: built.error, support } };
  }
  try {
    const raw = await ConnectionFactory.executeQuery<Record<string, unknown>>(
      opts.dialect,
      opts.option,
      built.sql,
      built.params,
    );
    const locks = normalizeLockWaitRows(raw);
    const chains = buildBlockingChains(locks);
    return { ok: true, value: { support, locks, chains } };
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : 'Session lock probe failed';
    const message = redactCredentials(rawMessage);
    const remedy = dbaPrivilegeRemedy(opts.dialect, 'sessions', rawMessage);
    return {
      ok: false,
      failure: {
        status: remedy ? 403 : 500,
        error: remedy ? `${message} — ${remedy}` : `${message} — ${support.hint}`,
        support,
      },
    };
  }
}

export async function executeSessionControl(opts: {
  dialect: string;
  option: ConnectionOptions;
  action: SessionControlAction;
  sessionId: string;
}): Promise<
  | { ok: true; value: { ok: true; sql: string; description: string } }
  | { ok: false; failure: { status: number; error: string } }
> {
  const built = buildSessionControlSql(opts.dialect, opts.action, opts.sessionId);
  if ('error' in built) {
    return { ok: false, failure: { status: 400, error: built.error } };
  }
  try {
    await ConnectionFactory.executeQuery(opts.dialect, opts.option, built.sql, []);
    return { ok: true, value: { ok: true, sql: built.sql, description: built.description } };
  } catch (error: unknown) {
    const message = redactCredentials(error instanceof Error ? error.message : 'Session control failed');
    return { ok: false, failure: { status: 500, error: message } };
  }
}

export async function probeTableHealth(opts: {
  dialect: string;
  option: ConnectionOptions;
  schema?: string;
}): Promise<
  | { ok: true; value: { support: TableMaintenanceSupport; tables: TableHealthRow[] } }
  | { ok: false; failure: { status: number; error: string; support: TableMaintenanceSupport } }
> {
  const support = dialectSupportsTableMaintenance(opts.dialect);
  if (!support.canInspectHealth) {
    return { ok: false, failure: { status: 400, error: support.hint, support } };
  }
  const built = buildTableHealthProbeQuery(opts.dialect, opts.schema);
  if ('error' in built) {
    return { ok: false, failure: { status: 400, error: built.error, support } };
  }
  try {
    const raw = await ConnectionFactory.executeQuery<Record<string, unknown>>(
      opts.dialect,
      opts.option,
      built.sql,
      built.params,
    );
    return { ok: true, value: { support, tables: normalizeTableHealthRows(raw) } };
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : 'Table health probe failed';
    const message = redactCredentials(rawMessage);
    const remedy = dbaPrivilegeRemedy(opts.dialect, 'sizes', rawMessage);
    return {
      ok: false,
      failure: {
        status: remedy ? 403 : 500,
        error: remedy ? `${message} — ${remedy}` : `${message} — ${support.hint}`,
        support,
      },
    };
  }
}

export async function executeTableMaintenance(opts: {
  dialect: string;
  option: ConnectionOptions;
  action: TableMaintenanceAction;
  schema?: string;
  table: string;
}): Promise<
  | { ok: true; value: { ok: true; sql: string; description: string } }
  | { ok: false; failure: { status: number; error: string } }
> {
  const built = buildTableMaintenanceSql(opts.dialect, opts.action, {
    schema: opts.schema,
    table: opts.table,
  });
  if ('error' in built) {
    return { ok: false, failure: { status: 400, error: built.error } };
  }
  try {
    await ConnectionFactory.executeQuery(opts.dialect, opts.option, built.sql, []);
    return { ok: true, value: { ok: true, sql: built.sql, description: built.description } };
  } catch (error: unknown) {
    const message = redactCredentials(error instanceof Error ? error.message : 'Table maintenance failed');
    return { ok: false, failure: { status: 500, error: message } };
  }
}
