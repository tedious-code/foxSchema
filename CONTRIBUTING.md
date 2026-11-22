# Contributing to Fox Schema

Thanks for your interest in improving Fox! New dialect support, bug fixes,
documentation, and tests are all especially welcome. This guide gets you from a
fresh clone to a running app with a passing test suite.

> Product name: **Fox**. Package/repo identity: **`foxschema`** (`@foxschema/*`) —
> both are intentional; don't "fix" one to match the other.

## Prerequisites

- **Node.js ≥ 22.5** (the app uses the built-in `node:sqlite`; Node 24 is what we
  develop on).
- **Docker** — for the test databases and the end-to-end suite.

User install channels: [docs/guides/install.md](docs/guides/install.md). Release publish:
[docs/guides/publish.md](docs/guides/publish.md). The rest of the docs, one file per topic:
[docs/README.md](docs/README.md).

## First-time setup

The engine packages are git submodules (see **Engine packages** below), so clone
with them:

```bash
git clone --recurse-submodules https://github.com/tedious-code/foxSchema.git
# already cloned? git submodule update --init
git config submodule.recurse true # keep them in step on pull / checkout / switch
npm install                       # installs the whole workspace

# Start the 6 test databases (Postgres, MySQL, MariaDB, SQL Server, Oracle, Db2)
docker compose up -d
bash scripts/seed/seed-all.sh all # seed demo_a/demo_b schemas into each

npm run dev                       # Fastify API + Vite UI (sign in; first open runs setup)
```

`npm run dev` serves the UI on **http://localhost:5173** and the **Fastify** API
on **:3210** (`packages/server`). Connection details for the seeded databases are
printed by `seed-all.sh` (all use `foxuser` / `foxpass` except SQL Server/Oracle —
see the script output).

The workflow engine runs in the API process. `npm run dev` sets a local
`FOXFLOW_ENCRYPTION_KEY`. Production needs a real 32-byte key. Runbook:
[docs/guides/workflow.md](docs/guides/workflow.md).

For the advanced test schemas (`demo_c` / `demo_d` — FK chains, cross-dialect type
matrix, materialized views, etc.): `bash scripts/seed/seed-advanced.sh all`.

## Correctness gates (run before every PR)

```bash
cd apps/web && npx tsc --noEmit   # primary typecheck gate
npx vitest run                    # from the repo root — the unit test suite
```

Both must be green. For database-touching changes, also run the relevant slice of
the Playwright E2E suite (see below).

## Repository layout

| Workspace | What it is |
|-----------|------------|
| [`packages/sql`](packages/sql) | Dialect knowledge: diff, migration generation, statement splitting, type mapping. Pure and browser-safe — zero deps, no Node built-ins. SQL lexing lives in `src/modules/sql-text/` (one tokenizer + per-dialect readings); do not add a second scanner. |
| [`packages/features`](packages/features) | Product features on `packages/sql`: access, DBA utilities, backup, Lokee Weave, SQL editor helpers. Pure. |
| [`packages/db`](packages/db) | The Node runtime: introspection, drivers, pooling, migration execution. Depends on `packages/sql`. |
| [`packages/db-db2`](packages/db-db2) | IBM Db2 as an add-on to `packages/db`. |
| [`packages/server`](packages/server) | Fastify HTTP API, feature modules, metadata store. |
| [`packages/workflow-engine`](packages/workflow-engine) | Workflow runtime, SQLite stores, built-in pipes. |
| [`apps/web`](apps/web) | React/Vite UI and the entry point that serves it (also used by the CLI launcher and Docker). |
| [`apps/cli`](apps/cli) | Public `foxschema` CLI — browser launcher, desktop shortcut, line commands, Ink TUI. |
| [`apps/e2e`](apps/e2e) | Playwright E2E tests against the dockerized databases. |

### Engine packages (git submodules)

`packages/sql`, `packages/db` and `packages/db-db2` are the publishable engine
libraries. Each lives in its own public repository and is a git submodule here:
[foxschema-sql](https://github.com/tedious-code/foxschema-sql),
[foxschema-db](https://github.com/tedious-code/foxschema-db),
[foxschema-db-db2](https://github.com/tedious-code/foxschema-db-db2).
`packages/features` is app code (the server and web app use it constantly, and
it is not published), so it stays an ordinary folder in this repository.
npm workspaces and every test treat them exactly as before. Changing one takes two
commits:

1. In the submodule (`cd packages/sql`): branch, commit, push, and open a PR in
   that repository. Its tests run from this repository's root (`npx vitest run
   packages/sql`), because they import their sibling workspaces.
2. Here: once that is merged, `git -C packages/sql pull` and commit the new
   submodule pointer in the foxSchema PR that needs it.

A submodule shows as `modified` in `git status` until its pointer is committed.
`git submodule status` shows the commit each one is pinned to.

The design, the migration pipeline, and the dialect system are described in
[docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) — read it before non-trivial changes.
Workspace-owned rows (`connections`, secrets, history, runs) are read and written
through a `WorkspaceScope`; see **Workspaces** there. Route unit tests use
`routeHandler` / `fakeReply` from `packages/server/src/platform/http/route-doubles.ts`.

## Running each surface

```bash
# Web (Fastify API + Vite UI)
npm run dev
npm run dev:auth                  # multi-user + auth enabled

# CLI / TUI (opens local UI like the published package)
cd apps/cli && npx tsx src/index.ts
cd apps/cli && npx tsx src/index.ts shortcut
cd apps/cli && npx tsx src/index.ts tui

# E2E (one dialect, or all)
npm -w @foxschema/e2e run test:postgres
npm -w @foxschema/e2e run test:all
# Access Assistant on local SQLite (no Docker)
npm run test:e2e:access
# Workflow designer smoke (engine must be up)
npm run test:e2e:workflow
```

**E2E hard rule:** migrations mutate the target, so re-seed before every run — use
`bash scripts/seed/reset-all.sh` (full `down -v` + up + reseed). Re-running against a
mutated target accumulates corruption and produces false failures.

`apps/e2e/scripts/run-all.mjs` is the sweep. Dialect-matrix suites (utilities,
database-access, access-assistant) get a wall-clock budget of **120s × configured
dialects** (minimum 600s). SQL Editor (twelve files) and revert-edge cases get
**600s**; everything else **300s**. A killed suite is logged as `runner timeout`,
not a mysterious empty FAIL.

Lokee capture / revert / force-migrate and `POST /schema/db-access` share a
**20 requests / minute** limiter. The suites run as one user, so History + Revert
+ revert-edges back-to-back used to toast “Snapshot failed” and wait 20–30s for a
version that was never recorded. New clicks go through
`apps/e2e/src/helpers/rate-limited.ts`: wait for **that** HTTP response, honour
`Retry-After` on 429, fail immediately on any other non-2xx. Do not click those
buttons with a bare Playwright `click` and then wait for the UI to look settled.

## Testing expectations

- Engine logic (compare, generator) → unit tests in `packages/sql`; drivers/providers → `packages/db`.
- CLI commands and the TUI → see the focused testing guides:
  [`apps/cli/src/commands/__tests__/README.md`](apps/cli/src/commands/__tests__/README.md)
  and [`apps/cli/src/tui/__tests__/README.md`](apps/cli/src/tui/__tests__/README.md)
  (they document the mock seams and some real timing gotchas).
- Real cross-dialect behavior → the E2E suite.
  Selectors: every control has a `data-testid`. Use `byTestId(...)` from
  `apps/e2e/src/helpers/test-ids.ts` (typed against the generated catalog).
  After adding a control, run `npm run test-ids` so `docs/testing/TEST_IDS.md`
  and `apps/e2e/src/generated/test-ids.ts` stay in sync. How to write a test:
  [docs/testing/WRITING_E2E.md](docs/testing/WRITING_E2E.md). An MCP server over
  the catalog (`.mcp.json` → `scripts/test-ids/mcp-server.mjs`) helps agents
  find IDs. CI comments each PR that changes the catalog.

Add or update tests with your change; a PR that changes behavior without tests will
be asked for them.

## Adding a new SQL dialect

Each dialect spans both packages: `sql-dialect.ts` / `settings.ts` under
`packages/sql/src/providers/<dialect>/`, and `adapter.ts` / `provider.ts` under
`packages/db/src/providers/<dialect>/`
(settings, adapter, provider, sql-dialect). Db2's adapter and provider are the
exception: they live in the add-on package `packages/db-db2`. Feature SQL for a
dialect (accounts, grants, backup, column change, DBA utilities, …) goes in
`packages/features/src/providers/<dialect>/`. The exact contract — required vs.
optional hooks, cross-cutting invariants (casing, index/FK naming, DROP ordering),
and per-dialect gotchas — is documented in
[`packages/sql/src/providers/DIALECTS.md`](packages/sql/src/providers/DIALECTS.md),
with the step-by-step checklist in [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md).
Read `DIALECTS.md` before touching any `*.sql-dialect.ts` or `sql-generator.module.ts`.
Wire-compatible relatives (MariaDB/TiDB, Cockroach/Yugabyte/Redshift, Azure SQL)
must go through `dialectFamily()` in `packages/sql/src/providers/provider-settings.ts`
— do not re-list `d === 'mysql' || d === 'mariadb' || …`. Backup/restore commands
are `<d>.backup.ts` registered in `packages/features/src/modules/utilities/backup.registry.ts`.

## Conventions worth knowing

A few rules that have bitten people before (the full set is in [CLAUDE.md](CLAUDE.md)):

- **The compare key is not a SQL identifier.** `obj.tableName` is the uppercased
  match key from `compare.module.ts` — use `source?.name` / `targetTable?.name` for
  real DDL (native casing; case-sensitive on MySQL).
- **Use `dialectFamily()`, not a handwritten family chain.** MariaDB/TiDB follow
  MySQL; CockroachDB/YugabyteDB/Redshift follow Postgres; Azure SQL follows SQL
  Server (`packages/sql/src/providers/provider-settings.ts`). Monaco Format, access
  SQL, and file-import batch sizes all go through it.
- **The app's metadata-DB migrations are append-only** — never edit a shipped
  migration in `packages/server/src/database/schema.ts`; add a new one.
- **Never store database passwords client-side or in history.** Saved connections
  are encrypted server-side; only host/database/schema/port/username reach the browser.
- **Keep React hooks above any early `return`** (a rules-of-hooks crash has happened).
- **The frontend may import browser-safe workspace packages** via Vite aliases
  (`@foxschema/ui-shared`, `@foxschema/shared` (including the workflow contract),
  `@foxschema/workflow-engine/definitions`). Thin facades live in
  `apps/web/src/frontend/shared/lib/`. Never import `@foxschema/db` or
  `@foxschema/server` from the UI, and take dialect code from
  `@foxschema/ui-shared`, not `@foxschema/sql`: to use something new from the
  engine in the browser, add it to `packages/ui-shared/src/index.ts`.

## Pull requests

1. Branch off `main`.
2. Keep the change focused; update docs and tests alongside code.
3. Ensure the correctness gates pass (`tsc --noEmit` + `vitest run`).
4. Write a **short, user-facing** PR description: what the user gets, why it
   matters, and how you verified it. Prefer a limited summary on GitHub — do
   **not** paste long internal implementation plans, agent transcripts, or
   speculative design dumps into public PR bodies.
5. Keep copyright / `NOTICE` / `LICENSE` intact. Prefer the SPDX header in
   [docs/conventions/COPYRIGHT_HEADER.txt](docs/conventions/COPYRIGHT_HEADER.txt) on new source files.
   Authorship: Huy Phan `<huyplb@gmail.com>` (see [NOTICE](NOTICE)).

Bug reports and feature ideas → open a GitHub issue. Security vulnerabilities →
**do not** open a public issue; follow [SECURITY.md](SECURITY.md).
