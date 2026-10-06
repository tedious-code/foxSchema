# Naming conventions

TypeScript naming rules for this repository. These describe what the code
already does — they were derived by counting, not invented — so following them
keeps a change indistinguishable from the code around it.

`packages/shared/src/naming.test.ts` enforces these rules. A new file that
breaks one fails the test rather than waiting for review.

## Files

### Which case

The case depends on the layer, and both layers are internally consistent:

| Where | Case | Example |
|---|---|---|
| `packages/*` | kebab-case | `dependency-scan.ts`, `code-cell-execute.service.ts` |
| `apps/web` frontend, non-component | camelCase | `dataMigratePlans.ts`, `exportCsv.ts` |
| React components (`.tsx`) | PascalCase | `DatabaseAccessModal.tsx` |
| React hooks | `use` + camelCase | `useAccessCatalog.ts`, `usePeekGridCrud.tsx` |

Measured at the time of writing: `packages/server` 96% kebab, `packages/sql`
94% kebab, frontend features 93% camel.

**The one exception**: a frontend file that is a thin re-export facade over
`@foxschema/sql` keeps the package's kebab-case name, so the two line up by
sight — `shared/lib/sql-splitter.ts` ↔ `modules/sql-text/sql-splitter.ts`. The
names match up to the package's role suffix, so `shared/lib/sql-generator.ts`
pairs with `modules/migrations/sql-generator.module.ts`. The frontend reaches
`@foxschema/sql` only through `@foxschema/ui-shared`, so a facade is a file
that imports from `@foxschema/ui-shared`. Nothing else in the frontend uses
kebab-case.

**A `components/` file is PascalCase when it exports one component**, named for
it. A file exporting a set of small related primitives is named for the set and
stays lowercase — `controls.tsx` (`Field`, `Segmented`, `EmptyState`),
`nodes.tsx` (the graph's node types).

### Role suffixes

`packages/server` names a file after its subject and its role:

```
<subject>.routes.ts       paths, methods, and which guards run
<subject>.guard.ts        admits or refuses a request
<subject>.handler.ts      one endpoint
<subject>.controller.ts   orchestrates services for one feature
<subject>.service.ts      business logic, no HTTP types
<subject>.worker.ts       worker entrypoint (loaded by path — renaming one
<subject>-thread.ts       needs a matching update at the call site)
```

A feature uses the roles it needs; it does not create empty ones.

### Per-dialect files

One file per engine, named `<dialect>.<concern>.ts`, in that dialect's provider
folder, registered in a registry under `modules/<domain>/`:

```
providers/postgres/postgres.sql-dialect.ts         → modules/dialect/registry.ts
providers/postgres/postgres.user-sql.ts            → modules/access/user-sql.registry.ts
providers/postgres/postgres.access-sql.ts          → modules/access/access-sql.registry.ts
providers/postgres/postgres.dba-utilities.ts       → modules/utilities/dba-utilities.registry.ts
providers/postgres/postgres.index-fragmentation.ts → modules/utilities/index-fragmentation.registry.ts
```

The module under `modules/<domain>/` is a facade: it resolves the dialect,
validates input and reshapes driver rows, and knows no catalog table by
name. Catalog SQL that is only right on one engine belongs in that engine's
provider file, never in a `switch` on the dialect id inside the module.

Aliases re-export rather than duplicate: Azure SQL → SQL Server, TiDB → MySQL,
CockroachDB and YugabyteDB → Postgres, MariaDB → MySQL.

### Tests and barrels

- Tests sit beside their subject: `foo.ts` → `foo.test.ts`.
- A second test file for one subject qualifies what it covers:
  `dependency-scan.tokenize.test.ts`, `user-sql.password.test.ts`.
- Barrels are always `index.ts`, and only where a folder has a public surface.

## Symbols

| Kind | Case | Notes |
|---|---|---|
| Type, interface, class, component | `PascalCase` | |
| Function, variable, singleton object | `camelCase` | |
| Constant lookup table or tuning value | `SCREAMING_SNAKE_CASE` | `PROVIDER_SETTINGS`, `MAX_WINDOW_ITEMS` |
| Type parameter | `T`, or `PascalCase` when it aids reading | |

Rules that hold everywhere in this repo:

- **No `I` prefix on interfaces.** `SqlDialect`, not `ISqlDialect`.
- **No `enum`.** There are zero in the repo. Use a union of string literals —
  it needs no runtime object and narrows better:
  ```ts
  export type AccessSourceKind = 'direct' | 'role' | 'denied';
  ```
- **`interface` for object shapes, `type` for unions and aliases.** Roughly even
  in count because they do different jobs.
- A boolean reads as a predicate: `canLogin`, `isWriteStatement`,
  `supportsAccessBuilder`, `hasNext`.
- A function that builds SQL is `build…`; one that reshapes driver rows is
  `normalize…`; one that answers a capability question is `dialectSupports…`.

## Known exceptions

These predate the convention and are allowed by name in `naming.test.ts`. The
list should shrink, never grow — a new file does not get added to it.

```
packages/server/src/defaultApiPort.ts
packages/server/src/startUiServer.ts
packages/sql/src/providers/mariaDb/mariaDb.settings.ts
packages/sql/src/providers/sqlLite/sqlLite.settings.ts
packages/db/src/providers/sqlLite/sqlLite.adapter.ts
packages/db/src/providers/sqlLite/sqlLite.provider.ts
apps/web/src/frontend/app/store/sync-types.ts
apps/web/src/frontend/app/store/sync-helpers.ts
apps/web/src/frontend/shared/lib/cloud-provider-settings.ts
apps/web/src/frontend/shared/lib/sql-variables.ts
apps/web/src/frontend/monaco-setup.ts
apps/web/src/frontend/features/access/lib/password-suggest.ts
apps/web/src/frontend/features/access/lib/access-draft.ts
```
