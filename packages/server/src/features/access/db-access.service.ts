/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared Database Access probe for POST /schema/db-access.
 */
import {
  ConnectionFactory,
  buildDbAccessPrincipalQueries,
  buildDbAccessPrivilegeQueries,
  dialectSupportsDbAccess,
  normalizeDbPrincipals,
  principalsFromPrivileges,
  normalizeDbPrivileges,
  reconcileDbAccess,
  impliedFixedRolePrivileges,
  type ConnectionOptions,
  type DbAccessSupport,
  type DbPrincipal,
  type DbPrivilege,
} from '@foxschema/db';
import { errorMessage } from '@foxschema/sql';

export type DbAccessProbeSuccess = {
  dialect: string;
  schema: string;
  mode: 'native' | 'estimated' | 'unsupported';
  support: DbAccessSupport;
  principals: DbPrincipal[];
  privileges: DbPrivilege[];
  warning?: string;
};

export type DbAccessProbeFailure = {
  error: string;
  support: DbAccessSupport;
  status: number;
};

async function firstSuccessfulQuery(
  dialect: string,
  option: ConnectionOptions,
  queries: Array<{ sql: string; params: unknown[] }>
): Promise<{ rows: Record<string, unknown>[]; failed: string[] }> {
  const failed: string[] = [];
  for (const q of queries) {
    try {
      const rows = await ConnectionFactory.executeQuery<Record<string, unknown>>(
        dialect,
        option,
        q.sql,
        q.params
      );
      return { rows: Array.isArray(rows) ? rows : [], failed };
    } catch (error: unknown) {
      failed.push(errorMessage(error));
    }
  }
  throw new Error(failed[failed.length - 1] || 'Catalog query failed.');
}

export async function probeDbAccess(opts: {
  dialect: string;
  option: ConnectionOptions;
  schema?: string;
}): Promise<{ ok: true; value: DbAccessProbeSuccess } | { ok: false; failure: DbAccessProbeFailure }> {
  const support = dialectSupportsDbAccess(opts.dialect);
  if (!support.query) {
    return {
      ok: false,
      failure: {
        status: 400,
        error: support.hint || 'This dialect does not support database access catalogs.',
        support,
      },
    };
  }

  const schema = (opts.schema ?? '').trim();
  try {
    const principalsQ = await firstSuccessfulQuery(
      opts.dialect,
      opts.option,
      buildDbAccessPrincipalQueries({ dialect: opts.dialect, schema })
    );
    const principals = normalizeDbPrincipals(principalsQ.rows);
    let privileges: DbPrivilege[] = [];
    let warning: string | undefined;
    try {
      const privQ = await firstSuccessfulQuery(
        opts.dialect,
        opts.option,
        buildDbAccessPrivilegeQueries({ dialect: opts.dialect, schema })
      );
      privileges = normalizeDbPrivileges(privQ.rows);
      if (privQ.failed.length) {
        warning = `Used a fallback privilege catalog after: ${privQ.failed[0]}`;
      }
    } catch (error: unknown) {
      const msg = errorMessage(error);
      warning = `Users and groups loaded; privileges could not be read (${msg}).`;
    }
    if (principalsQ.failed.length && !warning) {
      warning = `Used a fallback user catalog after: ${principalsQ.failed[0]}`;
    }

    // Db2 keeps its accounts outside the database, so an instance with no
    // user-defined roles returns no principals while the privilege list still
    // names real grantees. Deriving them keeps the panel usable instead of
    // showing privileges nobody can be selected to explain.
    let resolved = principals;
    if (resolved.length === 0 && privileges.length > 0) {
      resolved = principalsFromPrivileges(privileges);
      if (resolved.length > 0 && !warning) {
        warning =
          'This engine has no user catalog to read, so the principals below are the grantees ' +
          'named in its privileges.';
      }
    }
    // One answer about membership for every screen: the catalogs report it two
    // ways, and on several engines only one of them was filled.
    const reconciled = reconcileDbAccess({ principals: resolved, privileges });
    // SQL Server's fixed roles confer permissions no row lists (db_owner).
    reconciled.privileges.push(...impliedFixedRolePrivileges(opts.dialect, reconciled.principals));
    return {
      ok: true,
      value: {
        dialect: opts.dialect,
        schema,
        mode: support.mode,
        support,
        principals: reconciled.principals,
        privileges: reconciled.privileges,
        warning,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Database access probe failed';
    return {
      ok: false,
      failure: {
        status: 500,
        error: `${message} — ${support.hint}`,
        support,
      },
    };
  }
}
