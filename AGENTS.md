# AGENTS.md

Fox Schema (`foxschema`) is a database schema diff & migration tool: an npm-workspaces
monorepo delivered as a web app (`apps/web` = React/Vite UI + `packages/server`
Fastify API), a CLI (`apps/cli`), and the dialect engine (`packages/sql` +
`packages/db`). Optional workflow engine: `apps/workflow-server` ([docs/WORKFLOW.md](docs/WORKFLOW.md)).
See `README.md` and `CONTRIBUTING.md` for the product overview and the canonical
dev/test/build commands.

## Naming conventions

`docs/CONVENTIONS.md` records the TypeScript naming rules — kebab-case in
`packages/*`, camelCase in the `apps/web` frontend, PascalCase components, the
`<subject>.<role>.ts` server suffixes, and the `<dialect>.<concern>.ts` provider
layout. They are enforced by `packages/shared/src/naming.test.ts`, so a file
that breaks one fails `npx vitest run`. Read it before adding files.

## Cursor Cloud specific instructions

Standard commands live in `CONTRIBUTING.md` and `package.json` scripts (`npm run dev`,
`npm test` / `npx vitest run`, `cd apps/web && npx tsc --noEmit`, `npm run lint`,
`npm run build`). Notes below are only the non-obvious cloud caveats.

### Node version (important)
- This project needs **Node 24** (matches the maintainers' runtime; `package.json`
  engines is `>=22.5`). The environment is already configured so `node` resolves to
  **v24** in every shell (a symlink in `/usr/local/cargo/bin`, which is first on `PATH`,
  points at the nvm-installed Node 24; nvm `default` is also 24).
- Do **not** switch to the base image's `/exec-daemon/node` (v22.14): under it the
  SQL-editor "code cell" worker tests in
  `packages/server/src/features/sql-editor/code-cell-execute.service.test.ts`
  fail with `Unknown file extension ".ts"` (tsx-in-`worker_threads` incompatibility
  on that Node). On Node 24 the full suite is green.
- `better-sqlite3` ships N-API prebuilds (ABI-stable), so its native addon works across
  Node 22/24 without reinstalling — a Node switch alone does not require `npm install`.

### Running the app
- `npm run dev` runs the Fastify API (`:3210`) and Vite UI (`:5173`) together; open the
  UI at http://localhost:5173. API liveness: `GET http://localhost:3210/api/health`
  → `{"ok":true}`. Every install requires sign-in; first open runs admin setup. Workflow engine:
  `npm run dev:with-workflow` (needs `WORKFLOW_ENGINE_TOKEN` and
  `FOXFLOW_ENCRYPTION_KEY` — [docs/WORKFLOW.md](docs/WORKFLOW.md)).
- Vite is configured with `server.host: true`, `server.strictPort: true`, and
  `server.allowedHosts: true` so `http://127.0.0.1:5173` works (not only IPv6
  localhost), the port does not silently hop to 5174+, and Cursor/cloud
  port-forward Host headers are not rejected with 403 (which looks like a blank page).
- `apps/web/index.html` paints a dark `#020617` shell inline before JS/CSS so a
  hung module graph never shows a white page. If the embedded preview is still
  pure white while Playwright/`curl` see the UI, hard-refresh the preview panel.
- Vite prints a "Failed to run dependency scan … monaco-editor/esm/…" warning on startup.
  It is **non-fatal** — Monaco is installed and the SQL editor works; ignore it.

### Databases / Docker
- **Docker is not installed** in this environment. Everything in `docker-compose.yml`
  (Postgres/MySQL/MariaDB/SQL Server/Oracle/Db2/CockroachDB/Yugabyte test DBs) and the
  Dockerized dialect E2E suites (`npm run test:e2e:*`) therefore require installing
  Docker first.
- You do **not** need Docker to exercise the core compare/migrate engine: SQLite is
  file-based. Seed the demo DBs with `bash scripts/seed/seed-all.sh sqlite` (creates
  `/tmp/foxschema-sqlite/demo_a.db` and `demo_b.db`), then compare those two file paths
  as two SQLite connections (Dialect = SQLite, Database Name = the `.db` path; host/
  port/user/pass are ignored). `POST /api/compare` also accepts inline SQLite options.

### Lint
- `npm run lint` currently exits non-zero due to **one pre-existing error** in
  `apps/web/src/frontend/features/sql-editor/components/DataGrid.tsx`: `Definition for rule
  'react-hooks/exhaustive-deps' was not found` (the eslint config references a
  react-hooks rule whose plugin isn't loaded). This is unrelated to environment setup —
  don't assume you broke lint. The other ~49 items are pre-existing `security/*` warnings.
