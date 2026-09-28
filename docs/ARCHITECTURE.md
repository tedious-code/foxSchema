# Architecture reference

Stable orientation for FoxSchema. For where a change belongs see
[CODE_MAP.md](CODE_MAP.md). Workflow engine runbook: [WORKFLOW.md](WORKFLOW.md).

## What this is

Database schema **diff & migration** tool. Compare a source schema against a target,
generate dialect-native migration SQL, and deploy it. Fourteen SQL dialects:
Postgres (and CockroachDB / YugabyteDB / Redshift), MySQL (and MariaDB / TiDB),
SQL Server / Azure SQL, Oracle, Db2, SQLite, DuckDB, ClickHouse. MongoDB and Redis
carry connection settings only. Distributions: **CLI** (`foxschema` via npm/Homebrew)
and **Docker** (single amd64 image with Db2).

## Commands

```bash
# CLI-first (after npm i -g foxschema, or from the monorepo build)
foxschema                            # start UI on :3210 + open browser
foxschema stop
foxschema doctor

# Development (starts both the Fastify API + Vite frontend)
npm run dev                          # single-user mode (no login)
npm run dev:auth                     # multi-user auth mode
npm run dev:with-workflow            # plus workflow-server on :8081

# Typecheck — primary correctness gate
cd apps/web && npx tsc --noEmit

# Tests — run from repo root (covers packages/* and apps/web/**/*.test.ts)
npx vitest run                       # all tests
npx vitest run packages/sql         # dialect-layer tests only
npx vitest run packages/db          # driver/runtime tests only
npx vitest run --reporter=verbose    # with test names
npx vitest <pattern>                 # e.g. npx vitest sql-generator

# CLI (development)
cd apps/cli && npm run foxschema -- doctor
cd apps/cli && npm run foxschema -- compare --source ... --target ...
```

Backend changes (`packages/server`, `packages/sql`, `packages/db`) hot-reload via `tsx watch`.

## E2E tests (apps/e2e)

Playwright + Vitest against 6 Docker dialect containers. See the E2E workflow memory and
`docs/plans/2026-07-01-seed-test-matrix.md` for the operational details (reseed before
every run, restart backend before reseeding Oracle/DB2, DB2 `/var/custom` init).

```bash
# One-command reset: compose up + wait healthy + restart dev + reseed
bash scripts/seed/reset-all.sh
bash scripts/seed/seed-all.sh all    # reseed only

# Run the suite (dev server must be up)
cd apps/e2e && node scripts/run-all.mjs
```

## Repo layout

npm workspaces — not pnpm or Turborepo.

```
packages/sql/           @foxschema/sql — dialect knowledge (pure, browser-safe)
  src/interfaces/       TableSchema, TableDiff, ColumnDiff, MigrationStep, etc.
  src/modules/          One folder per domain: dialect, sql-text, schema-diff,
                        migrations, lokee-weave, sql-editor, access, utilities
  src/providers/        14 SQL dialects, each with settings + sql-dialect
                        (+ optional *.user-sql.ts for account DDL)
                        (MongoDB and Redis carry settings only)
  src/cores/            Connection strings, catalog rows → TableSchema,
                        connection auth (password / Windows NTLM / Db2 LDAP)

packages/db/            @foxschema/db — Node runtime: drivers, pooling, execution
  src/providers/        One adapter and provider per dialect
  src/cores/            ConnectionFactory, pooling, circuit breaker

packages/shared/        Contracts the frontend, server and CLI agree on:
                        permission names, error codes, wire message shapes
packages/server/        The backend: Fastify HTTP layer, feature modules,
                        metadata store
packages/workflow-contract  Browser-safe engine types and token/route names
packages/workflow-engine    Runtime, SQLite stores, built-in pipes (Node)

apps/web/src/frontend/
  app/                  Application shell, settings screens, global stores
  features/             One folder per business domain
  shared/               API client, UI components, lib, utils

apps/cli/               `foxschema` CLI — browser launcher (:3210), line commands, Ink TUI
apps/workflow-server/   Workflow engine HTTP process (:8081); optional scheduler/worker
apps/e2e/               Playwright tests that drive the running application
packaging/homebrew/     Scripts to refresh Formula/foxschema.rb (Homebrew, same repo)
```

`docs/CODE_MAP.md` says what each of those folders covers, and where a
change belongs.

```
Formula/                Homebrew formula (tap this GitHub repo directly)
```

## Database connection auth

Saved credentials keep `ConnectionOptions` (including optional `authMethod`
and `domain`) inside `encrypted_config`. Methods:

- `password` (default) — SQL / native username + password.
- `windows` — SQL Server / Azure NTLM. The adapter builds tedious
  `authentication.type = 'ntlm'` from domain + user + Windows password. Do
  **not** emit `Authentication=Active Directory Integrated` (that is AAD).
- `ldap` — Db2 directory user. Still UID/PWD; LDAP is server-side
  (`Authentication=SERVER_ENCRYPT` with the existing SERVER retry).

`SavedConnectionSummary` exposes `authMethod` / `domain` / `hasPassword` but
never the secret. Windows integrated SSO (no password) is not implemented.

The frontend imports **browser-safe** workspace packages through Vite aliases
(`@foxschema/sql`, `@foxschema/shared`, `@foxschema/workflow-contract`,
`@foxschema/workflow-engine/definitions`). Facades live in
`apps/web/src/frontend/shared/lib/`. `@foxschema/db` and `@foxschema/server`
are not aliased — a UI import of either fails the build.

`shared/lib/provider-settings.ts` used to be a real copy of the dialect registry,
kept on the theory that the browser should not pull the driver runtime in. It does
not: `@foxschema/sql` is dependency-free and Node-free by design, enforced by
`purity.test.ts`. The copy drifted on `postgres.schemaRequired` and broke schema
browsing for schema-less PostgreSQL connections, so it is a facade now, and
`provider-settings-facade.test.ts` asserts its exports are the same objects as
core's.

## How a migration runs

1. **Compare** (server-side): `POST /api/compare` → `CompareModule.compare()` → `TableDiff[]`
2. **Generate** (client-side): `SqlGeneratorModule.generateMigrationPlan(diffs, targetDialect, mapping)`
   → `MigrationStep[]`. Runs in the browser on every selection toggle — no round-trip.
3. **Execute** (server-side): `POST /api/migration/execute` → `MigrationModule` streams
   `MigrationEvent` objects via SSE back to `MigrationProgressPanel`.

`SchemaMapping` threads through generation: `sourceSchema`, `targetSchema`, `sourceDialect`,
`targetDialect`, `nonDestructive`, `targetServerVersion`.

## Dialect system

Each SQL dialect has three layers, split across `packages/sql/src/providers/`
(dialect + settings) and `packages/db/src/providers/` (adapter + provider).
Wire-compatible relatives share a family (`dialectFamily()` in
`packages/sql/src/providers/provider-settings.ts`): MariaDB / TiDB → `mysql`;
CockroachDB / YugabyteDB / Redshift → `postgres`; Azure SQL → `sqlserver`. Use
that helper instead of listing dialects by hand (Format / Monaco language, access
SQL, file-import batch size). `packages/sql` lists 14 SQL dialects (MongoDB and
Redis carry settings only):

| File | Interface | Registry |
|------|-----------|----------|
| `<d>.settings.ts` | `ProviderConnectionSettings` | `provider-settings.ts` |
| `<d>.adapter.ts` | `DriverAdapter` | `adapter-registry.ts` |
| `<d>.provider.ts` | `SchemaProvider` | `provider-registry.ts` |

Plus `<d>.sql-dialect.ts` implementing `SqlDialect` — registered in `modules/dialect/registry.ts`.

Account DDL (CREATE/ALTER/DROP USER|ROLE) is a sibling strategy, not on `SqlDialect`:
`<d>.user-sql.ts` implementing `UserSqlDialect`, registered in
`modules/access/user-sql.registry.ts`. Aliases re-export (e.g. Azure→SQL Server,
TiDB→MySQL); Redshift has its own module (GROUP, not ROLE). Db2 has no CREATE USER
(`canCreateUser: false`); `buildDb2OsUserInstructions` emits copy-paste docker +
GRANT CONNECT steps for the `foxschema-db2` container instead. GRANT/REVOKE is the
same pattern: `<d>.access-sql.ts` / `modules/access/access-sql.registry.ts`
(Redshift reuses Postgres GRANT; account DDL stays separate). Both stay in
`@foxschema/sql` so the browser Access Assistant can generate SQL — do not put
these emitters in `@foxschema/db` (Node drivers only).

The `SqlDialect` interface has optional hooks; the generator uses a generic fallback when a
hook is absent. Adding dialect-specific behavior = implement the hook in that dialect's file
only. Key hooks: `dropForeignKeyStatement`, `dropIndexStatement`, `dropTriggerStatement`,
`createTriggerStatement`, `preDropTableStatements`, `createViewStatement`, `alterViewStatement`,
`wrapCreateSequence`, `dropTableStatement`, `dropViewStatement`, `dropSequenceStatement`,
`dropFunctionStatement`, `dropProcedureStatement`. Full hook map + fallback behavior +
per-dialect gotchas live in `packages/sql/src/providers/DIALECTS.md` (local, gitignored).

Version-aware DDL: `SchemaProvider.detectVersion?()` → stored in Zustand as
`targetServerVersion` → flows into `SchemaMapping` → dialect drop hooks use it. Oracle pre-23c
uses PL/SQL exception blocks; DB2 (all versions) uses SQL PL `CONTINUE HANDLER FOR SQLSTATE '42704'`.

## Frontend store structure

`useSyncStore.ts` (Zustand) is split across three files:
- `sync-types.ts` — `SyncState` interface, `MigrationProgressItem`, `ConnectionConfig`
- `sync-helpers.ts` — `buildRef`, `buildMapping`, `buildIncludedDiffs`, `regenerateSql`,
  shared `sqlGeneratorModule` instance
- `useSyncStore.ts` — the store implementation

`regenerateSql` is called on every selection toggle; it runs `SqlGeneratorModule`
synchronously in the browser. `applyMigration` sends the full `MigrationStep[]` plan to the
backend and streams results back via SSE.

## Adding a dialect (checklist)

1. Create the dialect files in `packages/sql/src/providers/<name>/` and the driver files in `packages/db/src/providers/<name>/`
2. Register in `provider-settings.ts`, `adapter-registry.ts`, `provider-registry.ts`, `modules/dialect/registry.ts`
   (and `modules/access/user-sql.registry.ts` / `modules/access/access-sql.registry.ts` when the engine has account or GRANT SQL)
3. Add the dialect name to the `Dialect` union **and** the `DIALECTS` array in
   `packages/sql/src/providers/provider-settings.ts` (`dialect-registry.test.ts`
   fails until they match `PROVIDER_SETTINGS`). Nothing in `apps/web` needs
   editing — the frontend re-exports this registry.
4. Add `parseType`/`renderType` round-trip tests in `type-mapping.test.ts`
5. Verify each optional hook against real DDL — the generic fallbacks are often wrong for DROP INDEX/TRIGGER/FK
6. `npx vitest run` + `cd apps/web && npx tsc --noEmit`
