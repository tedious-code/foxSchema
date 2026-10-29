# Agent map

Lookup for schema types, the functions that own them, the forms that edit them, and the feature that ships them.

Read this before searching the tree. When a row names a file, open that file. Do not scan feature folders, and do not re-read `CODE_MAP.md` for the same question. Layout and import rules stay in [CODE_MAP.md](../CODE_MAP.md) and [FEATURE-MODULE-GUIDE.md](FEATURE-MODULE-GUIDE.md).

The web app imports dialect code from `@foxschema/ui-shared`, never `@foxschema/sql`. Server and CLI import `@foxschema/sql` and `@foxschema/db`.

## How a schema moves

```
catalog SQL in packages/sql/src/providers/<dialect>/
        │  SchemaProvider.loadSchema → DbSchema
        ▼
dbSchemaToTableSchemas          packages/sql/src/cores/schema-to-tables.ts
        │  (DB2 builds TableSchema itself; Postgres and MySQL share this)
        ▼
provider.getTables → TableSchema[]
        │
        ▼
loadScopedTables                packages/server/src/platform/connections/resolve.ts
        │  filters by DbObjectType scope, appends roles, then normalizeTableSchemas
        ▼
POST /api/schema/load           browse one side
POST /api/compare               CompareModule.compare → TableDiff[]
        │
        ▼
SqlGeneratorModule              packages/sql/src/modules/migrations/sql-generator.module.ts
        generateMigrationPlan / generateMigrationSql → statements run by the migration feature
```

`TableSchema` is the shape compare, the blueprint, and DDL generation share. `DbSchema` is the catalog-shaped model a provider builds and then flattens. Do not pass `DbSchema` into compare.

**The compare key is not an identifier.** `CompareModule` matches objects with `compareKey` (`packages/sql/src/modules/schema-diff/compare-key.ts`): qualifier stripped, name uppercased. `TableDiff.tableName` is that key. Emit DDL from `source?.name` or `targetTable?.name` (native casing). MySQL is case-sensitive.

## Schema types

All of these live in `packages/sql/src/interfaces/schema.interface.ts` unless noted.

| Type | What it is | Who consumes it |
|---|---|---|
| `DbSchema` | Catalog buckets: tables, columns, views, routines, triggers, sequences, types, keys, indexes | `SchemaProvider.loadSchema`; flattened by `dbSchemaToTableSchemas` |
| `TableSchema` | One comparable object. `objectType` is `TABLE`, `MQT`, `VIEW`, `FUNCTION`, `PROCEDURE`, `TRIGGER`, `SEQUENCE`, `TYPE`, or `ROLE` | Compare, blueprint, `SqlGeneratorModule.generateObjectDdl` |
| `ColumnInfo` | Column on a `TableSchema` (`name`, `type`, `nullable`, `defaultValue`, `primaryKey`, `identity`, `collation`) | Blueprint form, column diffs, DDL |
| `IndexInfo` | Index. `constraint: true` means a UNIQUE constraint (SQL Server: drop via `ALTER TABLE`, not `DROP INDEX`). `filter` is a partial-index predicate | Compare, Index Management |
| `ForeignKeyInfo` | FK. `referencedColumns` is filled by `normalizeTableSchemas` / `resolveFkReferencedColumns`. Keep `referencedSchema` or Data Peek drills the wrong table | Compare, Data Peek |
| `RoutineParameter` | `IN` / `OUT` / `INOUT` / `RETURN` / `RESULT` on functions and procedures | Routine DDL |
| `DbRole` | Role plus members. Members become columns on a `ROLE` `TableSchema` via `rolesToTableSchemas` | Compare, when the Roles scope is on |
| `TableDiff` and friends | Diff result (`SchemaCompareResult`) | `packages/sql/src/interfaces/diff.types.interface.ts`. Rendered by schema-diff |
| `ConnectionOptions` | Host, auth, pool, SSL. Passwords stay server-side | `packages/sql/src/interfaces/schema-provider.interface.ts` |
| `SchemaProvider` | `testConnection`, `loadSchema`, `getTables`, `getRoles`, `listSchemas`, `detectVersion` | One implementation per dialect under `packages/db/src/providers/<dialect>/` |

Shaping helpers, all in `packages/sql/src/cores/schema-to-tables.ts`:

| Function | Job |
|---|---|
| `dbSchemaToTableSchemas` | `DbSchema` → `TableSchema[]` |
| `normalizeTableSchemas` | Fill missing FK parent columns from the parent primary key |
| `resolveFkReferencedColumns` | Same fill for one foreign key. Needs real identifier strings |
| `rolesToTableSchemas` / `groupRoleRows` | Roles into the compare shape. A privilege failure becomes `roleSkippedWarning`, not a failed load |

## Functions

Open the function. Do not read the whole module to find it.

| Question | Function | File |
|---|---|---|
| Load one schema for the UI | `loadScopedTables` | `packages/server/src/platform/connections/resolve.ts` |
| Diff two schemas | `CompareModule.compare` | `packages/sql/src/modules/schema-diff/compare.module.ts` |
| Compare HTTP | `makeCompareService` → `compare` | `packages/server/src/features/compare/compare.service.ts` |
| Request body for compare | `parseCompareInput` | `packages/server/src/features/compare/compare.schema.ts` |
| Refuse a dialect pair | `schemaCompareBlocker` | `packages/sql/src/modules/capabilities/schema-compare.ts` |
| Match name for compare | `compareKey` | `packages/sql/src/modules/schema-diff/compare-key.ts` |
| Ignore schema prefixes in routine text | `normalizeDefinitionText` | `packages/sql/src/modules/schema-diff/definition-text.ts` |
| User unchecked a column or trigger | `applySelectionToDiff` | `packages/sql/src/modules/schema-diff/column-selection.ts` |
| Browse one side as a compare result | `buildBrowseResult` | `packages/sql/src/modules/schema-diff/browse.ts` |
| DDL for one object | `SqlGeneratorModule.generateObjectDdl` | `packages/sql/src/modules/migrations/sql-generator.module.ts` |
| DDL for a diff | `generateMigrationPlan`, `generateMigrationSql` | same file |
| Dialect object (hooks, types) | `resolveDialect` | `packages/sql/src/modules/dialect/registry.ts` |
| What a dialect can do | `dialectFeatures` / `supportsDialectFeature` | `packages/sql/src/modules/capabilities/dialect-features.ts` |
| Wire family (mysql / postgres / sqlserver) | `dialectFamily` | `packages/sql/src/providers/provider-settings.ts` |
| Split editor text into statements | `splitSqlStatements` | `packages/sql/src/modules/sql-text/sql-splitter.ts` |
| FoxScript parse | `parseFoxScript` | `packages/sql/src/modules/sql-editor/foxscript-ast.ts` |
| Grants and accounts | `buildGrantRevokeSql`, `dialectSupportsDbAccess` | `packages/sql/src/modules/access/db-access.ts` |
| Connection pool / sessions probe | `buildDbaUtilityQuery` | `packages/sql/src/modules/utilities/dba-utilities.ts` |
| Index fragmentation | `buildIndexFragmentationQuery` | `packages/sql/src/modules/utilities/index-fragmentation.ts` |
| Backup command text | `packages/sql/src/modules/utilities/backup.ts` plus `providers/<dialect>/*.backup.ts` | registered in `backup.registry.ts` |

Per-dialect SQL (catalog, DDL hooks, grants, backup, DBA probes) is `packages/sql/src/providers/<dialect>/`. Driver pools and `getTables` are `packages/db/src/providers/<dialect>/`. Hook list: [DIALECTS.md](../../packages/sql/src/providers/DIALECTS.md).

## Forms

A form is a React component. It belongs to the feature in the path. Other features import only that feature's root (`index.ts`, `view.ts`, `ui.ts`), never `components/`.

| Form | Feature | File | Writes through |
|---|---|---|---|
| Connection (password / Windows / LDAP) | connections | `apps/web/src/frontend/features/connections/components/ConnectionModal.tsx` | `POST/PUT /api/connections` |
| Credential manager | connections | `features/connections/components/` via `loadCredentialManager` | connections + app secrets |
| Table blueprint (create / edit) | sql-editor | `features/sql-editor/components/TableBlueprintModal.tsx` | opened from `SqlSchemaExplorer` |
| Schema explorer | sql-editor | `features/sql-editor/components/SqlSchemaExplorer.tsx` | `POST /api/schema/load` |
| Data peek (browse / edit rows) | sql-editor | `features/sql-editor/components/DataPeekPanel.tsx` | editor execute + `POST /api/schema/table-insight` |
| Write confirm | sql-editor | `features/sql-editor/components/WriteConfirmDialog.tsx` | gates mutating editor and peek actions |
| Schema tree | compare | `features/compare/components/SchemaTreePanel.tsx` | compare store |
| Object detail | compare | `features/compare/components/ObjectDetailPanel.tsx` | column and trigger selection |
| Deploy confirm | compare | `features/compare/components/DeployConfirmDialog.tsx` | `executeGate` then migration run |
| Cross-dialect readiness | compare | `features/compare/components/CrossDialectReadinessDialog.tsx` | before compare across families |
| Dependency / validation warnings | compare | `DependencyWarningDialog.tsx`, `ValidationWarningsDialog.tsx` | before execute |
| Migration progress | compare | `features/compare/components/MigrationProgressPanel.tsx` | migration feature stream |
| Diff briefing | schema-diff | `features/schema-diff/components/DiffBriefingPanel.tsx` | shared by compare and snapshots |
| Version compare | lokee-weave | `features/lokee-weave/components/VersionCompareModal.tsx` | history / Lokee |
| Force migrate | lokee-weave | `features/lokee-weave/components/ForceMigrateModal.tsx` | history |
| Index management | utilities | `features/utilities/components/IndexManagementModal.tsx` | access feature fragmentation routes |
| Clone table | utilities | `features/utilities/components/CloneTableModal.tsx` | editor execute |
| Backup & restore | utilities | `features/utilities/components/BackupRestorePanel.tsx` | `GET/PUT /api/backup-settings`; restore is never run |
| DB users & grants | utilities | `features/utilities/components/DatabaseAccessModal.tsx` | access feature |
| Server insights (pool, sessions, system, sizes) | utilities | `features/utilities/components/ServerInsightsModal.tsx` | `packages/sql` DBA probes via the access feature |
| Query a file | utilities | `features/utilities/components/FileQueryModal.tsx` | files feature |
| Commit migration to Git | git | `features/git/components/CommitMigrationDialog.tsx` | `/api/git` |
| Workspace switch / members / settings | workspaces | `WorkspaceMenu.tsx`, `WorkspaceSettingsDialog.tsx` | `/api/workspaces` |
| Admin users and roles | admin | `features/admin/components/AdminAccessPanel.tsx` | `/api/admin` |
| Admin workspaces | admin | `features/admin/components/AdminWorkspacesPanel.tsx` | `/api/workspaces` (`GET /all`) |
| Sign-in settings | admin | `features/admin/components/SignInSettingsPanel.tsx` | `/api/admin/sign-in` |
| Sign-in / onboarding | auth | `AuthPage`, `OnboardingWizard` via `features/auth/index.ts` | `/api/auth` |
| Workflow designer, runs, credentials, variables | workflow | `features/workflow/components/` | `/api/workflow` (engine proxy) |
| Send feedback | feedback | `features/feedback/components/FeedbackDialog.tsx` | opens a pre-filled GitHub issue |

Utilities is the workspace that hosts those tools (`UtilitiesView.tsx`). The tool id is one of `indexes`, `backup`, `dbAccess`, `clone`, `files`, `pool`, `sessions`, `system`, `sizes`.

## Features

Server modules are composed only in `packages/server/src/app/feature-registry.ts`. Workspace views are composed only in `apps/web/src/frontend/app/features/featureRegistry.ts` (`viewIds.ts` lists the ids). A new feature is `npm run feature:new -- <id>`.

| Feature | Server folder | Web folder | View id | User-facing surface |
|---|---|---|---|---|
| schema | `features/schema` | explorer lives in sql-editor | — | `POST /api/schema/load`, `/schema/list`, `/schema/table-insight` |
| compare | `features/compare` | `features/compare` | `sync` | Compare rail. Store holds the connection pair, result, and deploy selection |
| sql-editor | `features/sql-editor` | `features/sql-editor` | `sqlEditor` | Editor, blueprint, data peek, results. Store: `state/useSqlEditorStore.ts` |
| schema-diff | — (pure UI) | `features/schema-diff` | — | Diff rendering shared by compare and snapshots. Import `ui.ts` only from code that is already lazy |
| utilities | routes live in `access` and `backup` | `features/utilities` | `utilities` | Utils rail |
| access | `features/access` | `features/access` | `access` | Grants view, plus the probe routes Utils calls |
| backup | `features/backup` | panel is utilities | — | `/api/backup-settings` |
| migration | `features/migration` | `features/migrations` | — | Applies. History UI is `loadMigrationHistory` |
| history | `features/history` | `features/lokee-weave` | `snapshots` | Snapshots. Content-addressed versions: `packages/sql/src/modules/lokee-weave/` |
| connections | `features/connections` | `features/connections` | — | Saved connections. Store implementation: `platform/connections` |
| data-migrate | `features/data-migrate` | bar is `sql-editor/components/DataMigrateBar.tsx` | — | Copy rows between databases |
| files | `features/files` | panels under sql-editor and utilities | — | Upload, query a file, database-file picker |
| git | `features/git` | `features/git` | — | Commit a migration. `/api/git` |
| workspaces | `features/workspaces` | `features/workspaces` | — | Rail button under the Fox mark, not a view |
| workflow | `features/workflow` | `features/workflow` | `workflow` | Designer and runs. Engine process: `apps/workflow-server` |
| auth | `features/auth` | `features/auth` | — | Sign-in routes. Session service: `platform/identity` |
| admin | `features/admin` | `features/admin` | settings (shell) | Users, roles, secrets, sign-in policy |
| users | `features/users` | profile is shell / auth | — | `/api/user`, signup wizard |
| system | `features/system` | — | — | Health, version, updates |

Permission names and rail labels come from `packages/shared/src/nav.ts` (`COMMUNITY_NAV`). The view registry decides who sees a rail button; the server still checks the permission.

## When the map is not enough

| Need | Open |
|---|---|
| A dialect hook or a gotcha | `packages/sql/src/providers/DIALECTS.md` |
| Import direction, file names | `docs/CODE_MAP.md`, `docs/CONVENTIONS.md` |
| Add a feature | `docs/architecture/FEATURE-MODULE-GUIDE.md` |
| HTTP, logging, what is never logged | `docs/BACKEND_ARCHITECTURE.md` |
| SQL editor cells, FoxScript, peek | `.cursor/rules/sql-editor-agent-memory.mdc` |
