/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * App RBAC catalog: roles + permission keys + default grants.
 * Shared by API guards and the frontend UI (do not put Node-only imports here).
 */

/**
 * Ordered least → most privileged. `owner` sits between editor and admin:
 * full power over database schema and data (including GRANT and deploying
 * migrations), but no say over who may use the app — that stays with `admin`.
 */
export const APP_ROLES = ['viewer', 'editor', 'owner', 'admin'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value);
}

/** Fine-grained capabilities enforced on API + UI. */
export const PERMISSIONS = [
  // Schema Sync
  'schema.browse',
  'schema.compare',
  'schema.migrate',
  'schema.migrate.force',
  // SQL Editor
  'editor.access',
  'editor.run',
  // `editor.write` is the legacy umbrella, kept so grants saved before the
  // dml/ddl split keep working. New grants should use the finer keys below.
  'editor.write',
  'editor.dml',
  'editor.ddl',
  'editor.grant',
  'editor.advanced',
  'editor.variables.read',
  'editor.variables.write',
  'editor.variables.delete',
  'editor.sidebar.destinations',
  'editor.sidebar.bookmarks',
  'editor.sidebar.variables',
  'editor.sidebar.secrets',
  'editor.sidebar.utilities',
  'editor.sidebar.schema',
  'editor.datagrid.insert',
  'editor.datagrid.update',
  'editor.datagrid.delete',
  // Utilities (standalone + sidebar)
  'utility.access',
  'utility.index.drop',
  // Secrets vault
  'secrets.view',
  'secrets.create',
  'secrets.edit',
  'secrets.delete',
  // Access (database accounts / grants UI)
  'access.access',
  'access.users',
  'access.builder',
  'access.diff',
  'access.inspector',
  'access.report',
  // Compare history (Lokee / snapshots)
  'compare.history',
  // Workflow control plane (FoxWorkflow)
  'workflow.access',
  'workflow.design',
  'workflow.run',
  'workflow.admin',
  // Migrations in Git
  'git.view',
  'git.manage',
  // Workspaces
  'workspace.members',
  'workspace.settings',
  'workspace.create',
  // Administration
  'admin.users',
  'admin.roles',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

export interface PermissionMeta {
  id: Permission;
  group: string;
  label: string;
  description: string;
}

export const PERMISSION_META: PermissionMeta[] = [
  { id: 'schema.browse', group: 'Schema Sync', label: 'Browse schema', description: 'Load and inspect schema trees.' },
  { id: 'schema.compare', group: 'Schema Sync', label: 'Compare schemas', description: 'Run source vs target compare.' },
  { id: 'schema.migrate', group: 'Schema Sync', label: 'Execute migrations', description: 'Deploy generated migration SQL.' },
  { id: 'schema.migrate.force', group: 'Schema Sync', label: 'Force-migrate a version to any database', description: 'Apply a stored schema version to a database that is not the one the history was captured from. Deliberately skips the identity check that keeps reverts on their own database, so it can rewrite an unrelated schema — separate from Execute migrations, and not granted to owner by default.' },
  { id: 'editor.access', group: 'SQL Editor', label: 'Open SQL Editor', description: 'Switch to the SQL Editor workspace.' },
  { id: 'editor.run', group: 'SQL Editor', label: 'Run queries', description: 'Execute SELECT / read statements.' },
  { id: 'editor.write', group: 'SQL Editor', label: 'Run writes (legacy)', description: 'Umbrella kept for grants made before the DML/DDL split; implies both.' },
  { id: 'editor.dml', group: 'SQL Editor', label: 'Change data', description: 'INSERT / UPDATE / DELETE / MERGE and bulk load — row changes, no schema change.' },
  { id: 'editor.ddl', group: 'SQL Editor', label: 'Change schema', description: 'CREATE / ALTER / DROP / TRUNCATE on tables, views, indexes, procedures and functions.' },
  { id: 'editor.grant', group: 'SQL Editor', label: 'Grant privileges', description: 'GRANT / REVOKE on a connected database (Access control → Database, or Utilities → Database Access). Separate from Change schema because it can escalate what a database account may do.' },
  { id: 'editor.advanced', group: 'SQL Editor', label: 'Advanced / code cells', description: 'Run JS/TS/Node code cells and advanced editor tools.' },
  { id: 'editor.variables.read', group: 'SQL Editor', label: 'View variables', description: 'See SQL Editor variables.' },
  { id: 'editor.variables.write', group: 'SQL Editor', label: 'Edit variables', description: 'Create and update variables.' },
  { id: 'editor.variables.delete', group: 'SQL Editor', label: 'Delete variables', description: 'Remove variables.' },
  { id: 'editor.sidebar.destinations', group: 'SQL Editor sidebar', label: 'Destinations', description: 'Show Destinations section.' },
  { id: 'editor.sidebar.bookmarks', group: 'SQL Editor sidebar', label: 'Bookmarks', description: 'Show Bookmarks section.' },
  { id: 'editor.sidebar.variables', group: 'SQL Editor sidebar', label: 'Variables', description: 'Show Variables section.' },
  { id: 'editor.sidebar.secrets', group: 'SQL Editor sidebar', label: 'Secrets', description: 'Show Secrets vault section.' },
  { id: 'editor.sidebar.utilities', group: 'SQL Editor sidebar', label: 'Utilities', description: 'Legacy. Database utilities now live in the Utilities workspace (gated by Use utilities).' },
  { id: 'editor.sidebar.schema', group: 'SQL Editor sidebar', label: 'Schema', description: 'Show Schema explorer section.' },
  { id: 'editor.datagrid.insert', group: 'Data grid', label: 'Insert rows', description: 'Add / clone rows in Data Peek and editable query-result grids (also needs Change data).' },
  { id: 'editor.datagrid.update', group: 'Data grid', label: 'Update rows', description: 'Edit rows in Data Peek and editable query-result grids (also needs Change data).' },
  { id: 'editor.datagrid.delete', group: 'Data grid', label: 'Delete rows', description: 'Delete rows in Data Peek and editable query-result grids (also needs Change data).' },
  { id: 'utility.access', group: 'Utilities', label: 'Use utilities', description: 'Open the Utilities workspace (Index Management, Clone Table, Database Access, Server Insights, Query files). Database Access can list DB users/groups; running GRANT / REVOKE still needs Grant privileges.' },
  { id: 'utility.index.drop', group: 'Utilities', label: 'Drop indexes', description: 'Drop secondary indexes from Index Management. Constraint-backed indexes still need Edit table. Also needs Change schema.' },
  { id: 'secrets.view', group: 'Secrets', label: 'View secrets', description: 'List secrets (values still resolved only when needed).' },
  { id: 'secrets.create', group: 'Secrets', label: 'Add secrets', description: 'Create vault entries and cloud provider credentials.' },
  { id: 'secrets.edit', group: 'Secrets', label: 'Edit secrets', description: 'Update existing secrets and provider credentials.' },
  { id: 'secrets.delete', group: 'Secrets', label: 'Delete secrets', description: 'Remove secrets and provider credentials.' },
  { id: 'access.access', group: 'Access', label: 'Open Access', description: 'Switch to the Access workspace.' },
  { id: 'access.users', group: 'Access', label: 'Users', description: 'Manage database accounts (User Management).' },
  { id: 'access.builder', group: 'Access', label: 'Permission builder', description: 'Build GRANT / REVOKE intents for principals.' },
  { id: 'access.diff', group: 'Access', label: 'Permission diff', description: 'Compare effective privileges between principals or environments.' },
  { id: 'access.inspector', group: 'Access', label: 'Inspector', description: 'Inspect effective privileges for a principal.' },
  { id: 'access.report', group: 'Access', label: 'Access report', description: 'Generate access reports.' },
  { id: 'compare.history', group: 'Schema Sync', label: 'History', description: 'Open schema history / snapshots (Lokee).' },
  { id: 'workflow.access', group: 'Workflow', label: 'Open Workflow', description: 'Switch to the Workflow workspace.' },
  { id: 'workflow.design', group: 'Workflow', label: 'Design workflows', description: 'Edit workflow graphs in the Designer.' },
  { id: 'workflow.run', group: 'Workflow', label: 'Run workflows', description: 'Start workflow runs when the engine is enabled.' },
  { id: 'workflow.admin', group: 'Workflow', label: 'Workflow admin', description: 'Control panel: engine on/off, URL, and log sinks.' },
  { id: 'git.view', group: 'Git', label: 'View migration repositories', description: 'See the Git repositories migrations are committed to, their branches and history, and fetch from them. Committing, pulling and pushing also need Execute migrations.' },
  { id: 'git.manage', group: 'Git', label: 'Manage migration repositories', description: 'Add, edit and remove Git repositories, including their access tokens and whether a migration must be committed before it runs.' },
  { id: 'workspace.members', group: 'Workspace', label: 'Manage members', description: 'Invite people to the current workspace, change their workspace role, and remove them.' },
  { id: 'workspace.settings', group: 'Workspace', label: 'Workspace settings', description: 'Rename the current workspace, change whether it is public or private, and archive it.' },
  { id: 'workspace.create', group: 'Workspace', label: 'Create workspaces', description: 'Create workspaces besides your own. Install-wide: comes from the account role, not a workspace role.' },
  { id: 'admin.users', group: 'Admin', label: 'Manage users', description: 'List FoxSchema logins, assign app roles, and activate or deactivate accounts. Not the same as database users on a connected server.' },
  { id: 'admin.roles', group: 'Admin', label: 'Configure roles', description: 'Edit which FoxSchema permissions each app role receives, including Grant privileges for database GRANT/REVOKE.' },
];

const ALL = [...PERMISSIONS];

const VIEWER: Permission[] = [
  'schema.browse',
  'schema.compare',
  'compare.history',
  'editor.access',
  'editor.run',
  'editor.variables.read',
  'editor.sidebar.destinations',
  'editor.sidebar.bookmarks',
  'editor.sidebar.variables',
  'editor.sidebar.schema',
  'access.access',
  'access.inspector',
  'access.report',
  'workflow.access',
  'git.view',
];

const EDITOR: Permission[] = [
  ...VIEWER,
  // Data and schema on the objects an editor owns day to day. No GRANT (cannot
  // widen its own access) and no schema.migrate (deploying a generated plan to
  // a target database has a blast radius beyond one statement) — both on OWNER.
  'editor.dml',
  'editor.ddl',
  'editor.advanced',
  'editor.variables.write',
  'editor.variables.delete',
  'editor.sidebar.secrets',
  'editor.sidebar.utilities',
  'editor.datagrid.insert',
  'editor.datagrid.update',
  'editor.datagrid.delete',
  'utility.access',
  'utility.index.drop',
  'secrets.view',
  'secrets.create',
  'secrets.edit',
  'access.users',
  'access.builder',
  'access.diff',
  'workflow.design',
  'workflow.run',
];

/** Everything an editor has, plus privilege changes and migration deploys. */
const OWNER: Permission[] = [
  ...EDITOR,
  'schema.migrate',
  'editor.grant',
  'secrets.delete',
  'workflow.admin',
  'workspace.members',
  'workspace.settings',
];

const ADMIN: Permission[] = ALL;

/** Built-in defaults when role_permissions has no rows for a role. */
export const DEFAULT_ROLE_PERMISSIONS: Record<AppRole, Permission[]> = {
  viewer: VIEWER,
  editor: EDITOR,
  owner: OWNER,
  admin: ADMIN,
};

export function uniquePermissions(list: Iterable<unknown>): Permission[] {
  const out: Permission[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (!isPermission(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Permission a statement category demands. `read` needs none beyond
 * `editor.run`, which the route already requires.
 */
export const CATEGORY_PERMISSION: Record<'read' | 'dml' | 'ddl' | 'grant', Permission | null> = {
  read: null,
  dml: 'editor.dml',
  ddl: 'editor.ddl',
  grant: 'editor.grant',
};

/** Permission required for Data Peek / query-result grid row actions. */
export const DATAGRID_ACTION_PERMISSION: Record<
  'insert' | 'update' | 'delete',
  Permission
> = {
  insert: 'editor.datagrid.insert',
  update: 'editor.datagrid.update',
  delete: 'editor.datagrid.delete',
};

export function isDatagridAction(value: unknown): value is 'insert' | 'update' | 'delete' {
  return value === 'insert' || value === 'update' || value === 'delete';
}

/**
 * True when `granted` satisfies `needed`. The retired `editor.write` umbrella
 * still covers dml and ddl so grants saved before the split keep working — it
 * deliberately does NOT cover `editor.grant`, which was carved out precisely
 * because it can escalate privileges.
 */
export function permissionSatisfied(granted: Iterable<Permission>, needed: Permission): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  if (set.has(needed)) return true;
  if (needed === 'editor.dml' || needed === 'editor.ddl') return set.has('editor.write');
  // Legacy editor.grant covers Access builder/diff until roles are re-saved.
  if (needed === 'access.builder' || needed === 'access.diff') return set.has('editor.grant');
  return false;
}

/** Roles a member holds inside a workspace. `admin` is an account role only. */
export const WORKSPACE_ROLES = ['viewer', 'editor', 'owner'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * Permissions that belong to the install rather than to a workspace, so they
 * come from the account role. `editor.advanced` runs code on the server:
 * owning a workspace must never grant it. Workflows and Git repositories are
 * install-wide, and so is managing accounts and creating workspaces.
 */
export const INSTALL_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'editor.advanced',
  'workflow.access',
  'workflow.design',
  'workflow.run',
  'workflow.admin',
  'git.view',
  'git.manage',
  'admin.users',
  'admin.roles',
  'workspace.create',
]);

/**
 * What a request may do: the install permissions of the account role plus
 * the workspace permissions of the member's role in the current workspace.
 * Neither side can lend the other its keys.
 */
export function effectivePermissions(
  accountRolePermissions: Iterable<Permission>,
  workspaceRolePermissions: Iterable<Permission>
): Permission[] {
  const out = new Set<Permission>();
  for (const p of accountRolePermissions) if (INSTALL_PERMISSIONS.has(p)) out.add(p);
  for (const p of workspaceRolePermissions) if (!INSTALL_PERMISSIONS.has(p)) out.add(p);
  return [...out];
}
