/**
 * The Database Access Assistant's intent model.
 *
 * The point of this layer is that the UI never speaks SQL. A reader says "let
 * this user read the reporting schema, including tables made later" and the
 * dialect generators work out that PostgreSQL needs three statements for it
 * while SQL Server needs one. Everything here is database-independent; nothing
 * in this file may know a GRANT keyword.
 *
 * FoxSchema does not apply access changes — it explains and generates. The
 * database stays the source of truth.
 */
import { dialectFamily } from '@foxschema/sql';

/**
 * What a reader wants, not what the engine calls it.
 *
 * `read` is not `SELECT`: on a schema scope it also implies whatever the engine
 * needs to reach into that schema at all (Postgres USAGE), which is exactly the
 * detail this model exists to hide.
 */
export type AccessPermission =
  | 'connect'
  | 'read'
  | 'insert'
  | 'update'
  | 'delete'
  | 'create-object'
  | 'alter-object'
  | 'drop-object'
  | 'execute-function'
  | 'execute-procedure'
  | 'use-sequence'
  /** REFERENCES: may point a foreign key at this table. */
  | 'reference'
  /** Create and drop indexes on it. Not a PostgreSQL privilege — see object-grid. */
  | 'index-object'
  /** Create and drop triggers on it. */
  | 'trigger-object';

export const ACCESS_PERMISSIONS: readonly AccessPermission[] = [
  'connect',
  'read',
  'insert',
  'update',
  'delete',
  'create-object',
  'alter-object',
  'drop-object',
  'execute-function',
  'execute-procedure',
  'use-sequence',
  'reference',
  'index-object',
  'trigger-object',
];

export interface AccessPrincipal {
  type: 'user' | 'role';
  name: string;
}

export type AccessScope =
  | { type: 'database'; database: string }
  | { type: 'schema'; database?: string; schema: string }
  | { type: 'tables'; database?: string; schema: string; tables: string[] }
  | { type: 'columns'; database?: string; schema: string; table: string; columns: string[] }
  | { type: 'sequences'; database?: string; schema: string; sequences?: string[] }
  | {
      type: 'routines';
      database?: string;
      schema: string;
      /** Kind is carried per routine: engines name PROCEDURE and FUNCTION apart. */
      routines: { name: string; kind: 'procedure' | 'function' }[];
    };

export interface PermissionRequest {
  principal: AccessPrincipal;
  action: 'grant' | 'revoke' | 'deny';
  permissions: AccessPermission[];
  scope: AccessScope;
  /**
   * Apply the same access to objects created after this runs. Only meaningful
   * where `AccessCapabilities.futureObjects` is true — the generator refuses
   * rather than pretending, because silently dropping it would leave the reader
   * believing future tables are covered when they are not.
   */
  includeFutureObjects?: boolean;
  /** Let the grantee pass this access on. Always Critical risk. */
  withGrantOption?: boolean;
}

/**
 * How much damage this permission can do if the grant is wrong.
 *
 * Deliberately blunt: readers scanning a list need four buckets they can act
 * on, not a numeric score they have to interpret.
 */
export type PermissionRisk = 'low' | 'elevated' | 'administrative' | 'critical';

export const PERMISSION_RISK: Record<AccessPermission, PermissionRisk> = {
  connect: 'low',
  read: 'low',
  insert: 'elevated',
  update: 'elevated',
  delete: 'elevated',
  'execute-function': 'elevated',
  'execute-procedure': 'elevated',
  'use-sequence': 'low',
  reference: 'low',
  'index-object': 'administrative',
  'trigger-object': 'administrative',
  'create-object': 'administrative',
  'alter-object': 'administrative',
  'drop-object': 'critical',
};

const RISK_ORDER: readonly PermissionRisk[] = ['low', 'elevated', 'administrative', 'critical'];

/** The highest risk in a set — what a summary badge should show. */
export function highestRisk(
  permissions: readonly AccessPermission[],
  withGrantOption = false
): PermissionRisk {
  // WITH GRANT OPTION lets the grantee re-grant to anyone, so it outranks the
  // privileges it is attached to however tame those are on their own.
  if (withGrantOption) return 'critical';
  let worst: PermissionRisk = 'low';
  for (const p of permissions) {
    const risk = PERMISSION_RISK[p];
    if (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst)) worst = risk;
  }
  return worst;
}

/** Plain-English label plus the privilege name a DBA would recognise. */
export interface PermissionDescriptor {
  permission: AccessPermission;
  label: string;
  /** The engine-neutral privilege this usually maps to; shown as secondary text. */
  privilegeHint: string;
  description: string;
  risk: PermissionRisk;
}

/** Risk lives in `PERMISSION_RISK` only; descriptors read it rather than restate it. */
export const PERMISSION_DESCRIPTORS: readonly PermissionDescriptor[] = (
  [
    { permission: 'connect', label: 'Connect to database', privilegeHint: 'CONNECT', description: 'Allows opening a connection. Without it nothing else applies.' },
    { permission: 'read', label: 'Read data', privilegeHint: 'SELECT', description: 'Allows reading rows.' },
    { permission: 'insert', label: 'Insert data', privilegeHint: 'INSERT', description: 'Allows adding new rows.' },
    { permission: 'update', label: 'Update data', privilegeHint: 'UPDATE', description: 'Allows changing existing rows.' },
    { permission: 'delete', label: 'Delete data', privilegeHint: 'DELETE', description: 'Allows removing rows.' },
    { permission: 'create-object', label: 'Create objects', privilegeHint: 'CREATE', description: 'Allows creating tables, views and other objects.' },
    { permission: 'alter-object', label: 'Alter objects', privilegeHint: 'ALTER', description: 'Allows changing object definitions.' },
    { permission: 'drop-object', label: 'Drop objects', privilegeHint: 'DROP', description: 'Allows permanently removing objects.' },
    { permission: 'execute-function', label: 'Execute functions', privilegeHint: 'EXECUTE', description: 'Allows running functions.' },
    { permission: 'execute-procedure', label: 'Execute procedures', privilegeHint: 'EXECUTE', description: 'Allows running stored procedures.' },
    { permission: 'use-sequence', label: 'Use sequences', privilegeHint: 'USAGE/SELECT', description: 'Allows reading sequence values for inserts.' },
    { permission: 'reference', label: 'Reference', privilegeHint: 'REFERENCES', description: 'Allows pointing a foreign key at this table.' },
    { permission: 'index-object', label: 'Index', privilegeHint: 'INDEX', description: 'Allows creating and dropping indexes on it.' },
    { permission: 'trigger-object', label: 'Trigger', privilegeHint: 'TRIGGER', description: 'Allows creating and dropping triggers on it.' },
  ] as const
).map((d) => ({ ...d, risk: PERMISSION_RISK[d.permission] }));

const DESCRIPTOR_BY_PERMISSION = new Map(PERMISSION_DESCRIPTORS.map((d) => [d.permission, d]));

export function describePermission(permission: AccessPermission): PermissionDescriptor {
  // Every member of the union is in the table; the fallback keeps callers from
  // having to handle undefined for a case that cannot happen.
  return DESCRIPTOR_BY_PERMISSION.get(permission) ?? PERMISSION_DESCRIPTORS[0];
}

export type AccessPreset =
  | 'read-only'
  | 'read-write'
  | 'application-writer'
  | 'procedure-executor'
  | 'schema-developer'
  | 'custom';

/**
 * Presets answer "what should this user be able to do?" — the question a reader
 * can actually answer — instead of "which privileges do you want?", which
 * assumes they already know.
 */
export const ACCESS_PRESETS: Record<Exclude<AccessPreset, 'custom'>, AccessPermission[]> = {
  'read-only': ['connect', 'read'],
  'read-write': ['connect', 'read', 'insert', 'update', 'delete'],
  // Deliberately no delete: the common shape for an application account that
  // should never be able to erase history.
  'application-writer': ['connect', 'read', 'insert', 'update'],
  'procedure-executor': ['connect', 'execute-function', 'execute-procedure'],
  'schema-developer': [
    'connect',
    'read',
    'insert',
    'update',
    'delete',
    'create-object',
    'alter-object',
  ],
};

export function permissionsForPreset(preset: AccessPreset): AccessPermission[] {
  if (preset === 'custom') return [];
  return [...ACCESS_PRESETS[preset]];
}

/** The preset a permission set matches exactly, or 'custom' when it matches none. */
export function presetForPermissions(permissions: readonly AccessPermission[]): AccessPreset {
  const target = [...permissions].sort().join(',');
  for (const [preset, list] of Object.entries(ACCESS_PRESETS)) {
    if ([...list].sort().join(',') === target) return preset as AccessPreset;
  }
  return 'custom';
}

/**
 * What an engine can actually express, so the UI never offers a control that
 * cannot produce valid SQL.
 */
export interface AccessCapabilities {
  /** Scope levels the engine can grant at. */
  databaseScope: boolean;
  schemaScope: boolean;
  tableScope: boolean;
  columnScope: boolean;
  sequenceScope: boolean;
  /** Grants that apply to objects created later (Postgres DEFAULT PRIVILEGES). */
  futureObjects: boolean;
  /** Separate CONNECT-style privilege, rather than connection being implicit. */
  connectPrivilege: boolean;
  /** EXECUTE can be granted across a whole schema, not just per routine. */
  schemaWideExecute: boolean;
  /** WITH GRANT OPTION (or the engine's equivalent). */
  grantOption: boolean;
  /** SQL Server DENY statements (explicit deny overrides grants). */
  denyStatements: boolean;
}

const CAPABILITIES: Record<string, AccessCapabilities> = {
  postgres: {
    databaseScope: true,
    schemaScope: true,
    tableScope: true,
    columnScope: true,
    sequenceScope: true,
    futureObjects: true,
    connectPrivilege: true,
    schemaWideExecute: true,
    grantOption: true,
    denyStatements: false,
  },
  mysql: {
    databaseScope: true,
    schemaScope: false,
    tableScope: true,
    columnScope: true,
    sequenceScope: false,
    futureObjects: false,
    connectPrivilege: false,
    schemaWideExecute: true,
    grantOption: true,
    denyStatements: false,
  },
  mariadb: {
    databaseScope: true,
    schemaScope: false,
    tableScope: true,
    columnScope: true,
    sequenceScope: false,
    futureObjects: false,
    connectPrivilege: false,
    schemaWideExecute: true,
    grantOption: true,
    denyStatements: false,
  },
  sqlserver: {
    databaseScope: true,
    schemaScope: true,
    tableScope: true,
    columnScope: true,
    sequenceScope: false,
    futureObjects: false,
    connectPrivilege: true,
    schemaWideExecute: true,
    grantOption: true,
    denyStatements: true,
  },
  db2: {
    databaseScope: true,
    schemaScope: true,
    tableScope: true,
    columnScope: false,
    sequenceScope: false,
    futureObjects: false,
    connectPrivilege: true,
    schemaWideExecute: false,
    grantOption: true,
    denyStatements: false,
  },
  oracle: {
    databaseScope: true,
    schemaScope: false,
    tableScope: true,
    columnScope: true,
    sequenceScope: false,
    futureObjects: false,
    connectPrivilege: true,
    schemaWideExecute: false,
    grantOption: true,
    denyStatements: false,
  },
};

/** Dialects that behave as another engine for access purposes. */
export function accessFamily(dialect: string): string {
  const d = (dialect || '').toLowerCase();
  // MariaDB has its own entry in CAPABILITIES (and in db-access), so it is not
  // folded into MySQL. Every other relative shares its family's model —
  // Redshift included, because its GRANT syntax follows Postgres even though
  // its catalogs differ.
  if (d === 'mariadb') return 'mariadb';
  return dialectFamily(d);
}

/** Whether the dialect's family has its own privilege model (rather than the PostgreSQL fallback). */
export function hasAccessModel(dialect: string): boolean {
  return Object.hasOwn(CAPABILITIES, accessFamily(dialect));
}

const NO_ACCESS: AccessCapabilities = {
  databaseScope: false,
  schemaScope: false,
  tableScope: false,
  columnScope: false,
  sequenceScope: false,
  futureObjects: false,
  connectPrivilege: false,
  schemaWideExecute: false,
  grantOption: false,
  denyStatements: false,
};

/**
 * Engines with no GRANT model at all. Returning empty capabilities lets the UI
 * say so plainly instead of rendering a builder that can only fail.
 */
const UNSUPPORTED_DIALECTS = new Set(['sqlite', 'duckdb', 'clickhouse', 'mongodb', 'redis']);

/** Always a fresh object: callers must not be able to edit the shared table. */
export function accessCapabilities(dialect: string): AccessCapabilities {
  if (UNSUPPORTED_DIALECTS.has((dialect || '').toLowerCase())) return { ...NO_ACCESS };
  return { ...(CAPABILITIES[accessFamily(dialect)] ?? CAPABILITIES.postgres) };
}

export function supportsAccessBuilder(dialect: string): boolean {
  const caps = accessCapabilities(dialect);
  return (
    caps.databaseScope ||
    caps.schemaScope ||
    caps.tableScope ||
    caps.columnScope ||
    caps.sequenceScope
  );
}

/** Permissions this engine can express at this scope, in display order. */
export function availablePermissions(
  dialect: string,
  scopeType: AccessScope['type']
): AccessPermission[] {
  const caps = accessCapabilities(dialect);
  if (scopeType === 'columns') {
    return ['read', 'insert', 'update'];
  }
  if (scopeType === 'sequences') {
    return ['use-sequence', 'read'];
  }
  if (scopeType === 'routines') {
    return ['execute-procedure', 'execute-function', 'alter-object', 'drop-object'];
  }
  return ACCESS_PERMISSIONS.filter((p) => {
    // REFERENCES/INDEX/TRIGGER are offered only by the object grid, which
    // gates each one per dialect. Surfacing them here would put an INDEX
    // checkbox in front of a PostgreSQL reader, who has no GRANT for it.
    if (p === 'reference' || p === 'index-object' || p === 'trigger-object') return false;
    if (p === 'connect') return caps.connectPrivilege && scopeType === 'database';
    if (p === 'use-sequence') {
      return scopeType === 'schema' && caps.sequenceScope;
    }
    if (p === 'create-object' || p === 'alter-object' || p === 'drop-object') {
      return scopeType !== 'tables';
    }
    if (p === 'execute-function' || p === 'execute-procedure') {
      return scopeType !== 'tables' && caps.schemaWideExecute;
    }
    return true;
  });
}

/** One desired grant/revoke/deny the reader wants for a principal. */
export interface AccessDesiredState {
  principal: AccessPrincipal;
  requests: PermissionRequest[];
}
