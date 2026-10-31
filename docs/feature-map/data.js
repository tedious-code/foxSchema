// Reference data: the inventory of what Fox Schema ships, measured from the
// codebase on main b12bcd5607 (2026-10-31). Mirrors docs/FEATURE_MAP.md.
// Work items are not here: they live in the page's shared store.
const AREAS = [
  { id: 'platform', name: 'Platform' },
  { id: 'schema', name: 'Schema' },
  { id: 'editor', name: 'SQL editor & data' },
  { id: 'utilities', name: 'Utilities' },
  { id: 'access', name: 'Access' },
  { id: 'workflow', name: 'Workflow' },
  { id: 'tools', name: 'CLI & engines' },
];

const FEATURES = [
  { id: 'platform.auth', area: 'platform', name: 'Sign-in & accounts',
    subs: ['Password sign-in', 'Register', 'First-run setup code', 'Launch session', 'Email verification', 'Forgot / reset password', 'SSO: Google, Microsoft, GitHub, broker', 'Sign out other sessions', 'Onboarding wizard'],
    ui: 'Sign-in page, account banners', api: '/api/auth (17), /api/signup (3), /api/user (2)',
    code: 'server auth, users, platform/identity · web auth', perms: 'public routes',
    tables: 'users, sessions, auth_codes, user_preferences', tests: 'server 9 · web 3 · e2e auth-recovery, smoke' },
  { id: 'platform.admin', area: 'platform', name: 'Administration',
    subs: ['Users: create, invite, role, activate, set password, issue code', 'Hand over admin', 'Role → permission matrix', 'One admin or several', 'Sign-in settings: providers, mail, broker, public URL', 'Every workspace, restore archived', 'Demo role and demo mode: banner, sign-in hint'],
    ui: 'Profile → Access control', api: '/api/admin (19)',
    code: 'server admin · web admin', perms: 'admin.users, admin.roles',
    tables: 'users, role_permissions, app_settings', tests: 'server 4 · web 5 · e2e admin-policy, demo-role' },
  { id: 'platform.workspaces', area: 'platform', name: 'Workspaces',
    subs: ['Rail button and menu', 'Create, switch, archive, restore', 'Settings', 'Members and workspace roles', 'Personal workspace lends no more than its account holds', 'Invites: accept, decline, 14 days', 'Public discover and join', 'Shared workspace scripts'],
    ui: 'Rail button under the Fox mark', api: '/api/workspaces (20)',
    code: 'server workspaces, platform/workspaces · web workspaces', perms: 'workspace.members, workspace.settings, workspace.create',
    tables: 'workspaces, workspace_members, workspace_invites, workspace_scripts', tests: 'server 5 · web 3 · e2e workspaces, workspaces-sharing-limits' },
  { id: 'platform.connections', area: 'platform', name: 'Connections & drivers',
    subs: ['Credential manager', 'Connection form: password, Windows, LDAP, No password (Redis / MongoDB)', 'SSL and pool', 'SQLite / DuckDB file picker', 'Schema list', 'Connection test', 'Driver check and Install driver', 'Cloud provider credentials'],
    ui: 'Creds (rail), connection modal', api: '/api/connections (4), /api/connection/test, /api/db/test, /api/driver (2)',
    code: 'server connections, platform/connections, internal/driver-install · web connections', perms: 'workspace role; admin.drivers to install',
    tables: 'connections, cloud_provider_credentials', tests: 'server 1 · web 1' },
  { id: 'platform.secrets', area: 'platform', name: 'App secrets',
    subs: ['Vault entries', 'Cloud secret providers', 'Resolve a secret'],
    ui: 'Creds → secrets, editor Secrets panel', api: '/api/app-secrets (9)',
    code: 'server admin (app-secrets mount)', perms: 'secrets.view, create, edit, delete',
    tables: 'app_secrets, cloud_provider_credentials', tests: 'none dedicated' },
  { id: 'platform.system', area: 'platform', name: 'Shell, health & updates',
    subs: ['Activity rail and top toolbar', 'Command palette', 'Home', 'Backend-offline banner', 'Activity', 'App info and config', 'Update check and apply', 'Email and update settings', 'Send feedback'],
    ui: 'App shell, Prefs', api: '/api/health, /api/config, /api/app-info, /api/activity, /api/updates (2)',
    code: 'server system · web app/shell, app/settings, feedback', perms: '—',
    tables: 'app_settings', tests: 'server 1 · web 2 · e2e smoke, lazy-loading, send-feedback, auto-error-catch' },

  { id: 'schema.compare', area: 'schema', name: 'Compare & deploy',
    subs: ['Connection pair', 'Browse bar', 'Schema tree', 'Object detail: DDL diff, blueprint, tabs', 'Diff briefing', 'Cross-dialect readiness', 'Dependency and validation warnings', 'Execute gate: missing FK, narrowing', 'Deploy confirm', 'Streamed migration progress'],
    ui: 'Compare (rail)', api: '/api/compare, /api/schema/load, /api/schema/list, /api/migration/execute',
    code: 'server compare, schema, migration · web compare, schema-diff · sql schema-diff, migrations, dialect', perms: 'schema.browse, schema.compare, schema.migrate',
    tables: 'migration_runs', tests: 'sql 12 · web 14 · e2e compare-flow, execute-gate, schema-browse, 14 dialect suites' },
  { id: 'schema.applies', area: 'schema', name: 'Migration history',
    subs: ['Runs list', 'Script and results', 'Delete runs'],
    ui: 'Applies (rail)', api: '/api/migrations (5)',
    code: 'server migration · web migrations', perms: 'schema.migrate',
    tables: 'migration_runs', tests: 'server 3 · web 1' },
  { id: 'schema.git', area: 'schema', name: 'Migrations in Git',
    subs: ['Repositories (bare local copies)', 'Branches', 'Fetch, pull, push', 'Commit a migration', 'Preview', 'Applied tracking', 'Activity'],
    ui: 'Compare → Git, Admin', api: '/api/git (15)',
    code: 'server git · web git', perms: 'git.view, git.manage',
    tables: 'git_repos, git_applied, git_activity, migration_runs.git_*', tests: 'server 4 · web 1 · e2e git-migrations' },
  { id: 'schema.snapshots', area: 'schema', name: 'Snapshots (Lokee)',
    subs: ['Capture', 'Databases', 'Version timeline', 'Graph', 'Version compare', 'Change chart', 'Object inspector', 'Revert: plan → run', 'Force-migrate: plan → run', 'Rename a version'],
    ui: 'Snapshots (rail)', api: '/api/lokee (11)',
    code: 'server history · web lokee-weave · sql lokee-weave', perms: 'compare.history, schema.migrate.force',
    tables: 'lokee_databases, lokee_versions, lokee_version_objects, lokee_objects, lokee_latest_objects, lokee_shapes', tests: 'sql 15 · server 3 · web 14 · e2e schema-history, schema-revert, schema-version-revert-edges, schema-force-migrate' },

  { id: 'editor.run', area: 'editor', name: 'Editor & run',
    subs: ['Tabs, stored per workspace', 'Destinations', 'Run rail: In [n], ▶, include, Safe-mode marks, copy with values', 'Selection and caret run', 'Safe mode confirm', 'One transaction', 'Per-dialect write classification', 'Format SQL+JS', 'Clause-aware completions', 'Column picker', 'Shortcuts'],
    ui: 'Editor (rail)', api: '/api/sql/execute',
    code: 'server sql-editor (sql-execute, sql-page-wrap) · web sql-editor · sql sql-text, sql-editor', perms: 'editor.access, editor.run, editor.dml, editor.ddl, editor.grant',
    tables: '—', tests: 'server 7 · web 59 (feature) · sql 16 · e2e sql-editor-smoke, -sqlite, -join-typing, -running-state' },
  { id: 'editor.code', area: 'editor', name: 'FoxScript code cells',
    subs: ['JS, TS, Node, Node-TS cells', 'Transpile', 'sql bridge: bound params, sql.list, sql.raw', '-- @set', 'Server Beam: sql.on(source / target)', 'faker, lodash, date-fns', 'Built-in samples'],
    ui: 'Editor', api: '/api/sql/code-cell, /api/sql/code-cell/transpile',
    code: 'server sql-editor (code-cell-*) · web sql-editor/lib', perms: 'editor.advanced (install-wide)',
    tables: '—', tests: 'e2e sql-editor-code-cell-faker' },
  { id: 'editor.results', area: 'editor', name: 'Results grid',
    subs: ['By credential / side by side', 'Paging: rows per page, Next, Prev, seek', 'Cell and row edit', 'Copy and CSV export', 'Chart', 'Maximize', 'Runs drawer', 'Warnings'],
    ui: 'Editor', api: 'with /api/sql/execute',
    code: 'web ResultsPanel, DataGrid', perms: 'editor.datagrid.insert, update, delete',
    tables: '—', tests: 'e2e sql-editor-result-edit, -copy-export' },
  { id: 'editor.datacompare', area: 'editor', name: 'Data compare & migrate',
    subs: ['Compare toggle and Source', 'Diff cells', 'Key columns', 'Add, edit, delete', 'Sync column', 'Apply: Transaction where it can roll back, stop or continue, backup snapshot', 'History', 'Preview SQL', 'Multi-target'],
    ui: 'Editor, side by side', api: '/api/data-migrate/execute, /api/data-migrations (5)',
    code: 'server data-migrate · web DataMigrateBar', perms: 'editor.dml',
    tables: 'data_migrate_runs', tests: 'server 4 · e2e sql-editor-compare-multi-target' },
  { id: 'editor.peek', area: 'editor', name: 'Data peek',
    subs: ['Cmd/Ctrl-click to open', 'Stacked panels', 'WHERE (one row per AND), ORDER BY, limit', 'Paging', 'Row editor: add, edit, clone, delete, generators', 'Insight tab', 'FK drill and referenced-by', 'Date picker'],
    ui: 'Editor', api: 'with /api/sql/execute',
    code: 'web DataPeekPanel, PeekRowEditor, usePeekGridCrud', perms: 'editor.datagrid.*',
    tables: '—', tests: 'e2e sql-editor-data-peek-grid, -peek-row-form, -peek-stacking' },
  { id: 'editor.explorer', area: 'editor', name: 'Schema explorer & blueprint',
    subs: ['Connection picker', 'Object tree', 'Insert names', 'Object source script', 'Table blueprint: create, edit', 'New table (engines with DDL)', 'Redis and MongoDB keys as tables, with type badges', 'Install driver banner'],
    ui: 'Editor sidebar', api: '/api/schema/load',
    code: 'web SqlSchemaExplorer, TableBlueprintModal, MissingDriverBanner', perms: 'editor.sidebar.schema, schema.browse',
    tables: '—', tests: 'e2e sql-editor-blueprint, -column-picker' },
  { id: 'editor.library', area: 'editor', name: 'Bookmarks, variables & scripts',
    subs: ['Bookmarks', 'Samples', 'Recent', 'Variables', 'Secrets', 'Shared workspace scripts'],
    ui: 'Editor sidebar', api: '/api/workspaces/scripts (3)',
    code: 'web SqlBookmarksPanel, SqlVariablesPanel, SqlSecretsPanel', perms: 'editor.variables.*, editor.sidebar.*',
    tables: 'workspace_scripts', tests: 'counted with editor.run' },
  { id: 'editor.files', area: 'editor', name: 'File import & query',
    subs: ['Chunked upload sessions', 'Column detection', 'Import into a table', 'Query an uploaded CSV, JSON or NDJSON file', 'Capacity', 'Database-file picker'],
    ui: 'Editor → Files, Utils → Query files', api: '/api/files (11)',
    code: 'server files (parse worker pool)', perms: 'editor.run',
    tables: '—', tests: 'server 9' },

  { id: 'utilities.indexes', area: 'utilities', name: 'Index management',
    subs: ['Fragmentation', 'Custom probe: one read-only SELECT', 'Batch', 'Rebuild, reorg, optimize SQL', 'Db2: every index on the table', 'Drop'],
    ui: 'Utils (rail)', api: '/api/schema/index-fragmentation, -batch',
    code: 'server access (index-fragmentation) · sql utilities', perms: 'utility.access, utility.index.drop',
    tables: '—', tests: 'sql 7 · e2e sql-editor-utilities, -utilities-dialects' },
  { id: 'utilities.clone', area: 'utilities', name: 'Clone table',
    subs: ['Clone a table definition and rows'],
    ui: 'Utils', api: 'through /api/sql/execute', code: 'web CloneTableModal', perms: 'utility.access, editor.ddl',
    tables: '—', tests: 'utilities e2e' },
  { id: 'utilities.insights', area: 'utilities', name: 'Server insights',
    subs: ['Server insights', 'Table insight', 'Query files'],
    ui: 'Utils', api: '/api/schema/dba-utility, /api/schema/table-insight',
    code: 'server access (dba-utilities)', perms: 'utility.access', tables: '—', tests: 'utilities e2e' },
  { id: 'utilities.backup', area: 'utilities', name: 'Backup & Restore',
    subs: ['Per-engine command builders', 'Server-side SQL backup after confirmation', 'Recorded backups', 'Saved defaults'],
    ui: 'Utils', api: '/api/backup-settings (2)',
    code: 'server backup · sql providers/*/*.backup.ts', perms: 'utility.access',
    tables: 'backup_settings', tests: 'server 2 · e2e backup-restore-ui, backup-commands-dialects' },
  { id: 'utilities.dbaccess', area: 'utilities', name: 'DB users & grants',
    subs: ['Database Access modal'],
    ui: 'Utils', api: '/api/schema/db-access', code: 'server access (db-access)', perms: 'utility.access, editor.grant',
    tables: '—', tests: 'e2e database-access-dialects' },
  { id: 'utilities.trace', area: 'utilities', name: 'SQL Tracer',
    subs: ['Live: the engine\'s own sessions, about once a second', 'Fox activity: statements run from Fox on a saved connection', 'Secrets masked on the server', 'Stops at 15 min or 10,000 statements, on Stop, or on leaving', 'Open a statement in the editor'],
    ui: 'Utils → SQL Tracer', api: '/api/sql-trace (3)',
    code: 'server sql-trace, platform/sql-activity · sql utilities/sql-trace · web SqlTracerPanel', perms: 'utility.trace',
    tables: '—', tests: 'sql 1 · server 3 · web 1 · e2e utilities-sql-tracer' },

  { id: 'access.accounts', area: 'access', name: 'Database accounts',
    subs: ['Create', 'Rename', 'Drop', 'Passwords (per-engine DDL)'],
    ui: 'Access (rail)', api: '/api/schema/db-access',
    code: 'web access (UserManagement) · sql access, providers/*/*.user-sql.ts', perms: 'access.access, access.users',
    tables: '—', tests: 'sql 13 · web 12' },
  { id: 'access.builder', area: 'access', name: 'Permission builder',
    subs: ['Intent → GRANT / REVOKE', 'Grants stage', 'Object picker', 'Executes, stops at the first failure'],
    ui: 'Access', api: '/api/schema/db-access',
    code: 'web AccessPermissionPanel, AccessGrantsStage · sql providers/*/*.access-sql.ts', perms: 'access.builder, editor.grant',
    tables: '—', tests: 'e2e access-assistant-sqlite, access-assistant-dialects' },
  { id: 'access.inspector', area: 'access', name: 'Inspector & Insight',
    subs: ['Who holds what', 'Insight: privilege compare', 'Permission matrix'],
    ui: 'Access', api: '/api/schema/db-access',
    code: 'web PermissionInspector, PermissionDiff, PermissionMatrix', perms: 'access.inspector, access.diff',
    tables: '—', tests: 'access tests' },
  { id: 'access.report', area: 'access', name: 'Access report',
    subs: ['Report of grants and accounts'],
    ui: 'Access', api: '/api/schema/db-access', code: 'web AccessReport', perms: 'access.report',
    tables: '—', tests: 'access tests' },

  { id: 'workflow.designer', area: 'workflow', name: 'Designer',
    subs: ['Workflows list', 'Canvas: pipes and edges', 'Palette', 'Inspector', 'Triggers', 'SQL, script, HTTP and delimited editors', 'Dependencies'],
    ui: 'Workflow (rail)', api: 'engine proxy under /api/workflow',
    code: 'web workflow · workflow-engine definitions', perms: 'workflow.access, workflow.design',
    tables: "engine's own store", tests: 'web 12 · e2e workflow-designer-roundtrip' },
  { id: 'workflow.pipes', area: 'workflow', name: 'Pipes',
    subs: ['db: SQL on every dialect, Postgres and MySQL sources', 'http: request, multi-http, transform, sink, cookies', 'notify: email, SMS, SMTP', 'control: loop, split, merge, goto, human gate, sub-workflow', 'utility: CSV, delimited, JSON, script, text, transforms, verify, files', 'trigger'],
    ui: 'Designer palette', api: 'engine',
    code: 'packages/workflow-engine/src/pipes/*', perms: 'workflow.design',
    tables: '—', tests: 'workflow-engine 87' },
  { id: 'workflow.runs', area: 'workflow', name: 'Runs',
    subs: ['Execution panel', 'Cancel a live run', 'Answer a human gate', 'Variables', 'Credentials'],
    ui: 'Workflow', api: 'engine proxy',
    code: 'web RunsPanel, ExecutionPanel, VariablesPanel, CredentialsPanel', perms: 'workflow.run',
    tables: "engine's own store", tests: 'workflow tests' },
  { id: 'workflow.engine', area: 'workflow', name: 'Engine control plane',
    subs: ['Settings and health', 'Saved-connection grants', 'Internal resolve and engine-config routes (token-guarded)'],
    ui: 'Workflow → Engine', api: '/api/workflow (5), /api/workflow-internal (2)',
    code: 'server workflow · apps/workflow-server · workflow-contract', perms: 'workflow.admin',
    tables: 'workflow_settings, workflow_connection_grants', tests: 'server 6 · workflow-server 19 · e2e workflow-smoke' },

  { id: 'cli', area: 'tools', name: 'foxschema CLI & TUI',
    subs: ['setup', 'open', 'compare', 'migrate', 'snapshot', 'history', 'connections', 'drivers (install db2)', 'doctor', 'search', 'shortcut', 'reset-password', 'TUI screens'],
    ui: 'Terminal', api: 'packages + local server', code: 'apps/cli', perms: '—',
    tables: 'metadata store', tests: 'cli 25' },
  { id: 'engines.dialects', area: 'tools', name: '16 database engines',
    subs: ['SQL generation', 'Schema compare', 'Statement splitting', 'Type mapping', 'Drivers and pooling', 'Capability flags'],
    ui: '—', api: '—', code: 'packages/sql/src/providers · packages/db/src/providers', perms: '—',
    tables: '—', tests: 'sql 86 · db 24 · 14 dialect e2e suites' },
];

const ENGINES = {
  cols: ['Schema compare', 'DB access', 'User mgmt', 'Command mode', 'Row editing', 'Transactions'],
  rows: [
    ['PostgreSQL', 1, 1, 1, 1, 1, 1], ['CockroachDB', 1, 1, 1, 1, 1, 1], ['YugabyteDB', 1, 1, 1, 1, 1, 1],
    ['MySQL', 1, 1, 1, 1, 1, 1], ['MariaDB', 1, 1, 1, 1, 1, 1], ['TiDB', 1, 1, 1, 1, 1, 1],
    ['Db2', 1, 1, 1, 1, 1, 1], ['SQL Server', 1, 1, 1, 1, 1, 1], ['Azure SQL', 1, 1, 1, 1, 1, 1],
    ['Oracle', 1, 1, 1, 1, 1, 1], ['Redshift', 1, 1, 1, 1, 1, 1], ['SQLite', 1, 0, 0, 1, 1, 1],
    ['DuckDB', 1, 0, 0, 1, 1, 1], ['ClickHouse', 1, 0, 1, 1, 0, 0], ['Redis', 0, 0, 0, 0, 1, 0],
    ['MongoDB', 0, 0, 0, 0, 1, 0],
  ],
};

// Routes per feature, from the 158 pinned in http-contract.test.ts.
const ROUTES = [
  ['platform.auth', 22], ['platform.workspaces', 21], ['platform.admin', 20], ['schema.git', 15],
  ['schema.snapshots', 11], ['editor.files', 11], ['platform.secrets', 9], ['platform.connections', 8],
  ['workflow.engine', 7], ['platform.system', 6], ['editor.datacompare', 6], ['schema.applies', 5],
  ['utilities + access', 5], ['schema.compare', 4], ['editor.run + code', 3], ['utilities.trace', 3], ['utilities.backup', 2],
];

// Unit-test files per package.
const TESTS = [
  ['apps/web', 180], ['packages/server', 107], ['packages/workflow-engine', 87], ['packages/sql', 87],
  ['apps/cli', 25], ['packages/db', 26], ['apps/workflow-server', 19], ['packages/shared', 13],
  ['packages/workflow-contract', 1], ['packages/ui-shared', 1],
];

const E2E_GROUPS = ['PostgreSQL', 'MySQL', 'MariaDB', 'SQL Server', 'Oracle', 'DB2', 'SQLite', 'Azure SQL', 'ClickHouse', 'Redshift', 'CockroachDB', 'YugabyteDB', 'TiDB', 'DuckDB', 'Smoke', 'Sign-in', 'One admin or several', 'Workspaces', 'Demo role', 'SQL Editor (19 specs)', 'Send feedback', 'Browse', 'History', 'Revert', 'Revert edges', 'Force-migrate', 'Access SQLite', 'Workflow', 'Utilities', 'DB Access', 'Access all', 'Migrations in Git', 'Execute gate', 'Backup & Restore', 'Backup commands'];

// Metadata table → owning feature, column count (schema.ts, 31 migrations).
const TABLES = [
  ['users', 'platform.auth', 11], ['sessions', 'platform.auth', 6], ['auth_codes', 'platform.auth', 6], ['user_preferences', 'platform.auth', 7],
  ['role_permissions', 'platform.admin', 2], ['app_settings', 'platform.system', 3],
  ['workspaces', 'platform.workspaces', 8], ['workspace_members', 'platform.workspaces', 5], ['workspace_invites', 'platform.workspaces', 10], ['workspace_scripts', 'editor.library', 8],
  ['connections', 'platform.connections', 7], ['cloud_provider_credentials', 'platform.secrets', 7], ['app_secrets', 'platform.secrets', 8],
  ['migration_runs', 'schema.applies', 18], ['git_repos', 'schema.git', 12], ['git_applied', 'schema.git', 9], ['git_activity', 'schema.git', 6],
  ['lokee_databases', 'schema.snapshots', 10], ['lokee_versions', 'schema.snapshots', 19], ['lokee_version_objects', 'schema.snapshots', 6], ['lokee_objects', 'schema.snapshots', 9], ['lokee_latest_objects', 'schema.snapshots', 4], ['lokee_shapes', 'schema.snapshots', 3],
  ['data_migrate_runs', 'editor.datacompare', 19], ['backup_settings', 'utilities.backup', 4],
  ['workflow_settings', 'workflow.engine', 3], ['workflow_connection_grants', 'workflow.engine', 3], ['schema_migrations', 'platform.system', 3],
];

// Dialects: one plannable entry per engine, its checklist drawn from what the
// engine supports (ENGINES above) plus the gotchas DIALECTS.md records.
AREAS.push({ id: 'dialects', name: 'Dialects' });
const DIALECTS = [
  ['postgres', 'PostgreSQL', 'postgres', 'dialects/postgres', 'Run applies search_path. Renaming a role on md5 clears its password. The dev container trusts every login, so a passing password test proves nothing there.'],
  ['cockroachdb', 'CockroachDB', 'cockroachDb', 'dialects/cockroachdb', 'DDL auto-commits (autocommit_before_ddl), so a failed migration leaves earlier DDL applied.'],
  ['yugabytedb', 'YugabyteDB', 'yugabyteDb', 'dialects/yugabytedb', 'The dev container can stick on a stale master list; recreate its volume.'],
  ['mysql', 'MySQL', 'mysql', 'dialects/mysql', 'DDL auto-commits. Executable comments (/*! … */) can carry writes. Table names are case-sensitive on Linux.'],
  ['mariadb', 'MariaDB', 'mariaDb', 'dialects/mariadb', 'DDL auto-commits. Shares the mysql2 driver with MySQL.'],
  ['tidb', 'TiDB', 'tiDb', 'dialects/tidb', 'DDL auto-commits.'],
  ['db2', 'Db2', 'db2', 'dialects/db2', 'Fold the schema to uppercase, keep the table as SYSCAT stores it. REORG goes through SYSPROC.ADMIN_CMD. ibm_db needs a native build and has none for linux/arm64.'],
  ['sqlserver', 'SQL Server', 'sqlServer', 'dialects/mssql', 'Dropping a database user leaves the server login.'],
  ['azuresql', 'Azure SQL', 'azureSql', 'dialects/azuresql', 'TLS with certificate verification is on by default.'],
  ['oracle', 'Oracle', 'oracle', 'dialects/oracle', 'DDL auto-commits. Quoted names keep their case. The e2e account needs dictionary access to list roles.'],
  ['redshift', 'Redshift', 'redshift', 'dialects/redshift', 'Renaming a user always clears its password.'],
  ['sqlite', 'SQLite', 'sqlLite', 'dialects/sqlite', 'A file, not a server. No grants. ALTER TABLE is limited, so some migrations rebuild the table.'],
  ['duckdb', 'DuckDB', 'duckDb', 'dialects/duckdb', 'A file, not a server. No grants.'],
  ['clickhouse', 'ClickHouse', 'clickHouse', 'dialects/clickhouse', 'No row editing and no transactions. GRANT exists, but Fox has no permission builder for it yet.'],
  ['redis', 'Redis', 'redis', 'redis-editor', 'Runs the SQL subset. Keys read as tables: prefixes, lists, sets, sorted sets, streams and JSON (#552). Needs a password only when the connection names a user; a requirepass-only Redis keeps its password on the connection. The dev container falls back to no AUTH.'],
  ['mongodb', 'MongoDB', 'mongodb', '—', 'Runs the SQL subset. Auth is off in the dev container.'],
];
for (const [id, name, dir, e2e, watch] of DIALECTS) {
  const row = ENGINES.rows.find((r) => r[0] === name) || [name, 0, 0, 0, 0, 0, 0];
  const [, compare, dbAccess, users, , rowEditing, tx] = row;
  const subset = id === 'redis' || id === 'mongodb';
  const subs = ['Connect, test and browse the schema', 'Driver check and Install driver'];
  if (compare) subs.push('Compare two schemas', 'Generate and run migration DDL', 'Snapshots: capture, compare, revert');
  subs.push(subset ? 'Run the SQL subset (SELECT / INSERT / UPDATE / DELETE)' : 'Run SQL; writes classified for this dialect', 'Results paging');
  if (rowEditing) subs.push('Row editing and data peek');
  subs.push('Data compare and migrate between two databases');
  if (dbAccess) subs.push('Access: inspect, GRANT / REVOKE');
  if (users) subs.push('Database accounts: create, rename, drop');
  subs.push(tx ? 'One transaction rolls back' : 'One transaction refused with its reason');
  subs.push('Backup command builder');
  if (!subset) subs.push('Index fragmentation and maintenance SQL');
  FEATURES.push({
    id: 'dialect.' + id, area: 'dialects', name,
    subs, ui: 'Every screen with a connection picker', api: 'all connection-backed routes',
    code: 'packages/sql/src/providers/' + dir + ' · packages/db/src/providers/' + dir, perms: '—', tables: '—',
    tests: 'e2e ' + e2e + ' · provider unit tests in packages/sql and packages/db', watch,
  });
}
