/**
 * Connection resolution, shared by every feature that touches a database.
 *
 * `resolveRef` turns a connection reference — either a saved connection id or
 * an inline dialect plus options — into concrete credentials. `loadScopedTables`
 * reads a schema through the provider for that dialect.
 *
 * Both are plain functions so a service can take them as a dependency.
 */
import {
  buildConnectionString,
  normalizeTableSchemas,
  type ConnectionModule,
  type ConnectionOptions,
  type DbObjectType,
  type TableSchema,
} from '@foxschema/db';
import type { ConnectionStore } from '../../features/connections/connection-store.service';
import { ServiceError } from '../contracts/actor';
import type { WorkspaceScope } from '../http/scope';

/**
 * A connection reference: either a saved connection (resolved server-side so the
 * password never leaves the server) or an inline ad-hoc option.
 */
export interface ConnectionRef {
  connectionId?: string;
  dialect?: string;
  option?: ConnectionOptions;
  schema?: string;
  /**
   * Session password for a saved connection that was stored WITHOUT its password
   * ("save password" unticked). Supplied per-use, merged into the resolved option,
   * never persisted.
   */
  password?: string;
}

export interface ResolvedConnection {
  dialect: string;
  option: ConnectionOptions;
  schema: string;
}

export interface ScopedTables {
  tables: TableSchema[];
  warnings: string[];
}

export interface ConnectionResolver {
  resolveRef(scope: WorkspaceScope | undefined, ref: ConnectionRef): Promise<ResolvedConnection>;
  loadScopedTables(
    dialect: string,
    option: ConnectionOptions,
    schema: string,
    scope: DbObjectType[]
  ): Promise<ScopedTables>;
}

export function makeConnectionResolver(
  connectionModule: ConnectionModule,
  connectionStore: ConnectionStore
): ConnectionResolver {
  /** Resolve a ConnectionRef to concrete credentials (decrypting a saved one). */
  async function resolveRef(
    scope: WorkspaceScope | undefined,
    ref: ConnectionRef
  ): Promise<ResolvedConnection> {
    if (ref.connectionId) {
      if (!scope) {
        throw new ServiceError('unauthenticated', 'Sign in to use a saved connection');
      }
      const resolved = await connectionStore.resolve(scope, ref.connectionId);
      if (!resolved) throw new ServiceError('not_found', 'Saved connection not found');
      // Merge a per-session password for connections saved without one, and rebuild the
      // connection string so the driver picks it up. connectionString must be cleared
      // before rebuilding — several dialects' buildConnectionString() honors an existing
      // connectionString verbatim instead of reconstructing it from the fields, which
      // would silently keep the stored (passwordless) string and ignore the merge.
      let option = resolved.option;
      if (ref.password && !option.password) {
        option = { ...option, password: ref.password, connectionString: undefined };
        option.connectionString = buildConnectionString(resolved.dialect, option);
      }
      return { dialect: resolved.dialect, option, schema: ref.schema ?? resolved.schema ?? '' };
    }
    if (!ref.dialect || !ref.option) {
      throw new ServiceError(
        'invalid_input',
        'A connectionId or (dialect + option) is required'
      );
    }
    return { dialect: ref.dialect, option: ref.option, schema: ref.schema ?? '' };
  }

  async function loadScopedTables(
    dialect: string,
    option: ConnectionOptions,
    schema: string,
    scope: DbObjectType[]
  ): Promise<ScopedTables> {
    const provider = connectionModule.getProvider(dialect);
    if (!provider.getTables) {
      throw new ServiceError(
        'invalid_input',
        `Provider for dialect "${dialect}" does not support table listing`
      );
    }
    let tables = await provider.getTables(option, schema);
    const warnings: string[] = [];

    // Roles are server-global and need their own (privilege-gated) read. Only
    // fetch them when the user selected the Roles scope, and never let a
    // permission error abort the whole comparison — getRoles degrades to a warning.
    const wantRoles = !scope?.length || scope.includes('ROLE');
    if (wantRoles && provider.getRoles) {
      const { roles, warning } = await provider.getRoles(option, schema);
      tables = tables.concat(roles);
      if (warning) warnings.push(warning);
    }

    const scoped = scope?.length ? tables.filter((t) => scope.includes(t.objectType)) : tables;
    // Upgrade path: older providers / cached shapes may omit FK referencedColumns.
    return { tables: normalizeTableSchemas(scoped), warnings };
  }

  return { resolveRef, loadScopedTables };
}
