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
npm run dev                          # sign-in required; first open runs setup
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
                        (+ optional *.user-sql.ts for account DDL,
                        *.backup.ts for backup/restore commands)
                        (MongoDB and Redis carry settings only; they still
                        have backup command builders)
  src/cores/            Connection strings, catalog rows → TableSchema,
                        connection auth (password / Windows NTLM / Db2 LDAP)

packages/ui-shared/     @foxschema/ui-shared — the part of @foxschema/sql the
                        web app may use: a named, by-reference re-export. The
                        frontend imports this, never @foxschema/sql directly

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
(`@foxschema/ui-shared`, `@foxschema/shared`, `@foxschema/workflow-contract`,
`@foxschema/workflow-engine/definitions`). Facades live in
`apps/web/src/frontend/shared/lib/`. `@foxschema/db` and `@foxschema/server`
are not aliased — a UI import of either fails the build.

Dialect code reaches the browser only through `@foxschema/ui-shared`, which
names each `@foxschema/sql` export the frontend uses and re-exports it by
reference. Importing `@foxschema/sql` from the frontend fails
`apps/web/src/frontend/architecture.test.ts`. To use another part of the engine
in the browser, add it to `packages/ui-shared/src/index.ts`, where the change
shows up in review. `ui-shared.test.ts` checks that every name there is the
`@foxschema/sql` export itself, so the browser and the server cannot drift. The
bundle is unchanged: re-exports add no code.

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
`@foxschema/sql` so the browser Access Assistant can generate SQL (through
`@foxschema/ui-shared`) — do not put these emitters in `@foxschema/db` (Node
drivers only).

The `SqlDialect` interface has optional hooks; the generator uses a generic fallback when a
hook is absent. Adding dialect-specific behavior = implement the hook in that dialect's file
only. Key hooks: `dropForeignKeyStatement`, `dropIndexStatement`, `dropTriggerStatement`,
`createTriggerStatement`, `preDropTableStatements`, `createViewStatement`, `alterViewStatement`,
`wrapCreateSequence`, `dropTableStatement`, `dropViewStatement`, `dropSequenceStatement`,
`dropFunctionStatement`, `dropProcedureStatement`. Full hook map + fallback behavior +
per-dialect gotchas live in `packages/sql/src/providers/DIALECTS.md` (tracked).

Version-aware DDL: `SchemaProvider.detectVersion?()` → stored in Zustand as
`targetServerVersion` → flows into `SchemaMapping` → dialect drop hooks use it. Oracle pre-23c
uses PL/SQL exception blocks; DB2 (all versions) uses SQL PL `CONTINUE HANDLER FOR SQLSTATE '42704'`.

## Frontend store structure

The Compare store (Zustand) lives in `features/compare/state/`, split across three files:
- `syncTypes.ts` — `SyncState` interface, `MigrationProgressItem`, `ConnectionConfig`
- `syncHelpers.ts` — `buildRef`, `buildMapping`, `buildIncludedDiffs`, `regenerateSql`,
  shared `sqlGeneratorModule` instance
- `useSyncStore.ts` — the store implementation

Other features read it through `@/features/compare`. The SQL editor store is
`features/sql-editor/state/useSqlEditorStore.ts`, read through `@/features/sql-editor/state`.

`regenerateSql` is called on every selection toggle; it runs `SqlGeneratorModule`
synchronously in the browser. `applyMigration` sends the full `MigrationStep[]` plan to the
backend and streams results back via SSE.

## Frontend loading and delivery

A first visit downloads index.html and what it names: about 144 KB gzip (120 KB Brotli)
since 2026-10-10, down from 398 KB before 2026-10-06. CI keeps it under 170 KB gzip
(`npm run bundle:first-load` after `npm run build -w @foxschema/web`); the report lists the
largest files when it fails. Everything else loads when it is used:

- **Views** load from the view registry (`app/features/featureRegistry.ts`), each from its
  feature's `view.ts`. App.tsx renders them with `lazy()`, and the activity rail calls
  `prefetchView` on hover or focus, so a view's code is usually already loaded by the time
  the click lands.
- **Panels that open on a click** (admin console, credentials, applies history, new
  connection) are `lazy()` inside `MountWhenOpened`. That mounts a panel on its first open
  and keeps it mounted afterwards, so its state survives closing exactly as before.
- **Heavy libraries** (sql-formatter, Prettier, faker, lodash, date-fns, zod, ajv) load
  through `shared/lib/loadOnce.ts`: one shared promise, retried after a failure. A
  component that needs one while rendering uses `useLoaded(loader)`, which re-renders
  once when the library arrives. `useSqlFormat` is the example: DDL shows unformatted
  for that first moment, then formatted.
- **A feature's `index.ts` stays light**, because the first screen imports it: a module
  re-exported there is downloaded by everyone who imports any of it (Rolldown does not drop
  unused re-exports of modules with top-level calls; one `index.ts` import from the
  toolbar once cost 54 KB gzip). Heavier pieces get their own root entry: `ui.ts` for
  components other features compose, `state.ts` for the SQL editor store, `view.ts` for
  the workspace, `toolbar.ts` for what a view adds to the top toolbar. Lazy components are
  `load…` functions in `index.ts`, never re-exports.
- **The code-cell worker is an ES module worker** (`worker.format: 'es'`). The default
  IIFE format inlined faker, lodash and date-fns into the worker.
- **TypeScript code cells compile on the server** (`POST /api/sql/code-cell/transpile`,
  the same `transpileTs` Node cells use) and run in the browser. The browser no longer
  downloads the TypeScript compiler (3.4 MB).
- **Stores stay out of the first page.** The shell reads recent queries from
  `features/sql-editor/state/recentQueries.ts` (through `@/features/sql-editor`), a small
  copy that follows the SQL editor store once it loads; Home and the command palette load that store on a click. The sync store loads
  the migration generator with the first browse or compare (`loadSqlGenerator`), and
  `sqlGenerator()` throws if a path uses it earlier, rather than returning an empty
  script. The Compare button asks `schemaCompareBlocker` from
  `packages/sql/src/modules/capabilities/schema-compare.ts`, which reads the dialect key
  list (`SQL_DIALECT_KEYS`, checked against `DIALECT_MAP` by `satisfies`) instead of
  loading every dialect.
- **Sign-in, onboarding and the signup offer** are lazy: a signed-in first page does not
  carry them. Startup asks for the setup state and the session at once, and starts
  loading the view the reader last had open while it does.
- **React has its own chunk** (`vendor-react`), so it stays cached across releases while
  the app's entry chunk changes name with every app change.

The server sends the build pre-compressed. `src/build/precompress.ts` writes `.br` and
`.gz` copies at build time, and `packages/server/src/api/static-assets.ts` serves them:
Brotli, then gzip, then the file itself. Hashed `/assets/*` files are cached for a year
(`immutable`); index.html and other paths get `no-cache`. A missing `/assets/*` file is a
404, not index.html. A tab left open across a release then hits `vite:preloadError`,
and `main.tsx` reloads it once. The CLI package leaves the compressed copies out
(loopback gains nothing from them).

Rendering on the hot paths (what to keep when editing these components):

- The SQL editor store saves through `shared/lib/deferredLocalStorage.ts`: 400 ms after
  the last change and at once on `pagehide` / hidden, not on every keystroke. Code that
  reads the saved copy in the same page dispatches `pagehide` first (the e2e
  `SqlEditorPage` does).
- The migration plan is cached in the sync store on the identity of its inputs
  (`cachedPlan`), so Execute, the Git commit check and the review notes share one build.
- The Compare tree rows, the permission matrix rows and the results panel are
  `React.memo` and are passed stable props; an inline callback or a default `[]` prop
  breaks that. The statement strip caches each statement's checks by its text.

## Adding a dialect (checklist)

1. Create the dialect files in `packages/sql/src/providers/<name>/` and the driver files in `packages/db/src/providers/<name>/`
2. Register in `provider-settings.ts`, `adapter-registry.ts`, `provider-registry.ts`, `modules/dialect/registry.ts`
   (and `modules/access/user-sql.registry.ts` / `modules/access/access-sql.registry.ts` when the engine has account or GRANT SQL).
   Backup/restore commands: `<d>.backup.ts` in `modules/utilities/backup.registry.ts`. A `history` query, where the engine records its backups, lets the panel list them; a server-side SQL backup can be run from the panel, a restore never is.
3. Add the dialect name to the `Dialect` union **and** the `DIALECTS` array in
   `packages/sql/src/providers/provider-settings.ts` (`dialect-registry.test.ts`
   fails until they match `PROVIDER_SETTINGS`). Nothing in `apps/web` needs
   editing — the frontend re-exports this registry.
4. Add `parseType`/`renderType` round-trip tests in `type-mapping.test.ts`
5. Verify each optional hook against real DDL — the generic fallbacks are often wrong for DROP INDEX/TRIGGER/FK
6. `npx vitest run` + `cd apps/web && npx tsc --noEmit`
