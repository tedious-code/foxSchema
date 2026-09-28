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

User install channels: [docs/INSTALL.md](docs/INSTALL.md). Release publish:
[docs/PUBLISH.md](docs/PUBLISH.md).

## First-time setup

```bash
npm install                       # installs the whole workspace

# Start the 6 test databases (Postgres, MySQL, MariaDB, SQL Server, Oracle, Db2)
docker compose up -d
bash scripts/seed/seed-all.sh all # seed demo_a/demo_b schemas into each

npm run dev                       # Fastify API + Vite UI (single-user mode)
```

`npm run dev` serves the UI on **http://localhost:5173** and the **Fastify** API
on **:3210** (`packages/server`). Connection details for the seeded databases are
printed by `seed-all.sh` (all use `foxuser` / `foxpass` except SQL Server/Oracle —
see the script output).

Workflow engine (optional, separate process on **:8081**):

```bash
export WORKFLOW_ENGINE_TOKEN="$(openssl rand -hex 32)"
export FOXFLOW_ENCRYPTION_KEY="$(openssl rand -hex 32)"
npm run dev:with-workflow
```

Then **Workflow → Engine → Enabled**. Runbook: [docs/WORKFLOW.md](docs/WORKFLOW.md).

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
| [`packages/sql`](packages/sql) | Dialect knowledge: diff, migration generation, statement splitting, type mapping. Pure and browser-safe — zero deps, no Node built-ins. |
| [`packages/db`](packages/db) | The Node runtime: introspection, drivers, pooling, migration execution. Depends on `packages/sql`. |
| [`packages/server`](packages/server) | Fastify HTTP API, feature modules, metadata store. |
| [`packages/workflow-engine`](packages/workflow-engine) | Workflow runtime, SQLite stores, built-in pipes. |
| [`apps/web`](apps/web) | React/Vite UI and the entry point that serves it (also used by the CLI launcher and Docker). |
| [`apps/cli`](apps/cli) | Public `foxschema` CLI — browser launcher, desktop shortcut, line commands, Ink TUI. |
| [`apps/workflow-server`](apps/workflow-server) | Workflow engine HTTP process (`:8081`). |
| [`apps/e2e`](apps/e2e) | Playwright E2E tests against the dockerized databases. |

The design, the migration pipeline, and the dialect system are described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — read it before non-trivial changes.

## Running each surface

```bash
# Web (Fastify API + Vite UI)
npm run dev
npm run dev:auth                  # multi-user + auth enabled
npm run dev:with-workflow         # API + UI + workflow-server (:8081)

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

Add or update tests with your change; a PR that changes behavior without tests will
be asked for them.

## Adding a new SQL dialect

Each dialect spans both packages: `sql-dialect.ts` / `settings.ts` under
`packages/sql/src/providers/<dialect>/`, and `adapter.ts` / `provider.ts` under
`packages/db/src/providers/<dialect>/`
(settings, adapter, provider, sql-dialect). The exact contract — required vs.
optional hooks, cross-cutting invariants (casing, index/FK naming, DROP ordering),
and per-dialect gotchas — is documented in
[`packages/sql/src/providers/DIALECTS.md`](packages/sql/src/providers/DIALECTS.md)
(tracked; allowlisted in `.gitignore`),
with the step-by-step checklist in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Read `DIALECTS.md` before touching any `*.sql-dialect.ts` or `sql-generator.module.ts`.
Wire-compatible relatives (MariaDB/TiDB, Cockroach/Yugabyte/Redshift, Azure SQL)
must go through `dialectFamily()` in `packages/sql/src/providers/provider-settings.ts`
— do not re-list `d === 'mysql' || d === 'mariadb' || …`.

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
  (`@foxschema/sql`, `@foxschema/shared`, `@foxschema/workflow-contract`,
  `@foxschema/workflow-engine/definitions`). Thin facades live in
  `apps/web/src/frontend/shared/lib/`. Never import `@foxschema/db` or
  `@foxschema/server` from the UI.

## Pull requests

1. Branch off `main`.
2. Keep the change focused; update docs and tests alongside code.
3. Ensure the correctness gates pass (`tsc --noEmit` + `vitest run`).
4. Write a **short, user-facing** PR description: what the user gets, why it
   matters, and how you verified it. Prefer a limited summary on GitHub — do
   **not** paste long internal implementation plans, agent transcripts, or
   speculative design dumps into public PR bodies.
5. Keep copyright / `NOTICE` / `LICENSE` intact. Prefer the SPDX header in
   [docs/COPYRIGHT_HEADER.txt](docs/COPYRIGHT_HEADER.txt) on new source files.
   Authorship: Huy Phan `<huyplb@gmail.com>` (see [NOTICE](NOTICE)).

Bug reports and feature ideas → open a GitHub issue. Security vulnerabilities →
**do not** open a public issue; follow [SECURITY.md](SECURITY.md).
