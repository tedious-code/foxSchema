/**
 * Thin re-export facade over `@foxschema/sql` for the Database Access
 * Assistant. Frontend code imports from here, never from `@foxschema/db`.
 *
 * Also owns the few Access-UI helpers that sit on top of that facade
 * (`AccessPrincipalDraft`, `connectionDatabaseNames`, `permissionBand`).
 */
export {
  ACCESS_PERMISSIONS,
  ACCESS_PRESETS,
  PERMISSION_DESCRIPTORS,
  PERMISSION_RISK,
  accessCapabilities,
  accessFamily,
  availablePermissions,
  buildAccessSql,
  buildUserSql,
  buildDb2OsUserInstructions,
  osAccountSteps,
  DB2_DOCKER_CONTAINER,
  generateDb2OsPassword,
  validateDb2OsPassword,
  DB2_OS_PASSWORD_LENGTH,
  userManagementSupport,
  userCreateModes,
  PASSWORD_PLACEHOLDER,
  describePermission,
  cellSupport,
  compileObjectGrid,
  compileGridChanges,
  gridObjectKey,
  heldGridPermissions,
  expandToInstance,
  accessStatementPlace,
  qualifyDatabaseSql,
  gridColumnsFor,
  prunedPermissions,
  highestRisk,
  invertAccessRequest,
  diffAccessDesired,
  buildAccessReconciliationSql,
  permissionsForPreset,
  presetForPermissions,
  supportsAccessBuilder,
  type AccessCapabilities,
  type AccessPermission,
  type AccessPreset,
  type AccessPrincipal,
  type CellSupport,
  type DbObjectType,
  type GridChanges,
  type GridObjectKind,
  type GridRow,
  type AccessScope,
  type AccessDesiredState,
  type AccessDiffEntry,
  type AccessDiffResult,
  type AccessDiffStatus,
  type AccessWarningLevel,
  type GeneratedPermissionSql,
  type GeneratedStatement,
  type PermissionDescriptor,
  type PermissionRequest,
  type PermissionRisk,
  type PermissionWarning,
  type GeneratedUserSql,
  type PrincipalType,
  type UserCreateMode,
  DEFAULT_DB2_RUN_MODE,
  type Db2RunMode,
  type OsAccountSteps,
  type UserAction,
  type UserAlteration,
  type UserManagementSupport,
  type UserRequest,
  permissionsForPrivilege,
  resolveEffectiveAccess,
  resolveRoleChain,
  type AccessSource,
  type AccessSourceKind,
  type EffectiveAccess,
  type EffectiveEntry,
  type EffectiveObject,
  buildAccessReport,
  principalsWithAccessTo,
  dialectSupportsDbAccess,
  privilegesForPrincipal,
  type AccessFinding,
  type AccessReport,
  type PrincipalAccessRow,
  type DbPrincipal,
  type DbPrincipalKind,
  type DbPrivilege,
} from '@foxschema/sql';

import { accessFamily, type AccessPermission } from '@foxschema/sql';

/** Which band of the permission grid a permission sits in: data (DML) or definition (DDL). */
export function permissionBand(p: AccessPermission): 'DML' | 'DDL' {
  return p === 'read' ||
    p === 'insert' ||
    p === 'update' ||
    p === 'delete' ||
    p === 'execute-procedure' ||
    p === 'execute-function'
    ? 'DML'
    : 'DDL';
}

/** Draft carried from User Management into the permission panel. */
export interface AccessPrincipalDraft {
  connectionId: string;
  principalName: string;
  principalType: 'user' | 'role';
}

/**
 * Which names from the access catalog are actually databases.
 *
 * `fetchSchemaList` returns schemas. On the MySQL family those are databases
 * (`db.*` is the GRANT target). Everywhere else a schema is not a database —
 * treating `public` as one would emit `GRANT CONNECT ON DATABASE public`.
 */
export function connectionDatabaseNames(opts: {
  dialect?: string;
  database?: string;
  schemas?: readonly string[];
}): string[] {
  const family = accessFamily(opts.dialect ?? '');
  const dbs = new Set<string>();
  const connected = opts.database?.trim();
  if (connected) dbs.add(connected);
  if (family === 'mysql' || family === 'mariadb') {
    for (const s of opts.schemas ?? []) {
      const name = s.trim();
      if (name) dbs.add(name);
    }
  }
  return [...dbs].sort((a, b) => a.localeCompare(b));
}
