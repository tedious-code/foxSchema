# Workflow engine

FoxSchema designs and administers workflows in the web UI. The engine runs in
an **isolated sandbox child process** (`packages/server/src/features/workflow/runtime`)
that **only FoxSchema can reach** over a private OS IPC channel.

User walkthrough: [user-guide.md](user-guide.md#workflow). Deploy env vars:
[DEPLOYMENT.md](DEPLOYMENT.md#workflow-engine). Folder map: [CODE_MAP.md](../architecture/CODE_MAP.md).

## Architecture

```
Browser  ── /api/workflow/* (session + RBAC) ──►  FoxSchema API  (:3210)
                                                    │ Private OS IPC only (no TCP/Unix listener)
                                                    ▼
                                       Sandboxed Engine Child Process
                                  (Node --permission, stripped env, heap cap)
                    ┌───────────────────────────────┼──────────────────────────┐
                    │                               │                          │
              scheduler + cron                SQLite FOXFLOW_DB_PATH     /api/hooks/*
              (inside sandbox)                (exact file allowlist)     (proxied via FoxSchema)
```

| Piece | Role |
|-------|------|
| `apps/web/src/frontend/features/workflow` | Designer, runs, credentials, Engine control plane |
| `packages/server/src/features/workflow` | Settings, connection grants, `ENGINE_ROUTES` RBAC & workspace-connection proxy |
| `packages/server/src/features/workflow/runtime` | Sandbox supervisor (`sandbox-client.ts`, `sandbox-policy.ts`, `sandbox.worker.ts`), route plugins, SQL probe |
| `packages/workflow-engine` | Definitions, compiler, runtime, SQLite stores, built-in pipes |
| `packages/shared` (`workflow-types.ts`, `workflow-constants.ts`) | Browser-safe workflow types and constants |

The designer talks to `/api/workflow/engine/*` with a FoxSchema session, which
FoxSchema authorizes and forwards over private IPC to the sandbox child.
Webhook ingress (`/api/hooks/*` by path, `/api/triggers/:workflowId/:triggerId` by id)
is also proxied through FoxSchema with exact raw request bytes preserved for HMAC
verification (`runtime/routes/triggers.ts`), so the engine child never opens a
listening network socket of its own.

Saving a workflow runs the same checks the executor will: every pipe must be
usable, and every edge `fromPort` must be a port the source pipe declares
(`assertKnownFromPorts` in `packages/workflow-engine/src/runtime/ports.ts`,
called from `packages/server/src/features/workflow/runtime/routes/workflows.ts`). An unknown port is
refused at save (`pipeline p: edge split → out: unknown fromPort "eu"`), not
discovered when a scheduled run fails. Pipes without static metadata skip the
check (Goto).

Saved FoxSchema connections resolve over reverse-IPC RPC through
`WorkflowConnectionGrants.resolveForEngine` in the FoxSchema parent process.
The sandboxed engine child never receives `APP_ENCRYPTION_KEY`, `SESSION_SECRET`,
or filesystem access to `foxschema.db`.

## Local development

`npm run dev` starts the API with a local `FOXFLOW_ENCRYPTION_KEY` (`dev:api`)
and the in-process engine. New installs default to **enabled**, so Test run
works after sign-in.

| Process | Default |
|---------|---------|
| FoxSchema API + engine | http://127.0.0.1:3210 |
| Vite UI | http://localhost:5173 |

Then in the UI: **Workflow → Engine**. The Workflow rail item is on
(`NAV_FLAGS.workflow` in `apps/web/src/frontend/app/features/featureRegistry.ts`).
**Add samples** on the designer (or the Workflows list) installs
`sample-hello-records`, `sample-orders-branch`, and `sample-regions-join`.
Health: `GET /api/workflow/engine/health` with a session.

Production still requires a real `FOXFLOW_ENCRYPTION_KEY` (32 bytes, hex or
base64). Do not alias it to `APP_ENCRYPTION_KEY`.

All engine stores share one SQLite file. The default path is **repo-root**
`workflow-engine.sqlite`, not `process.cwd()`. Set `FOXFLOW_DB_PATH` to override.
A later optional extract can split scheduler/worker processes; they are not a
second API.

## Permissions

Same four names on the activity rail, workspace tabs, and engine allowlist
(`packages/shared/src/permissions.ts`, `packages/shared/src/nav.ts`):

| Permission | Who (defaults) | What |
|------------|----------------|------|
| `workflow.access` | viewer+ | Open Workflow; list workflows/runs; read pipe catalog |
| `workflow.design` | editor+ | Designer, variables, credentials list; grant a saved connection |
| `workflow.run` | editor+ | Start, cancel, and resume runs (a start is refused unless engine state is `enabled`). The Runs panel answers a human gate |
| `workflow.admin` | owner+ (not editor) | Engine control plane; create/delete engine credentials |

A viewer who can open Workflow does not see Designer / Variables / Engine chrome
that would only 403 (`WorkflowView.tsx`).

## Built-in pipes

Registry: `createDefaultPipeRegistry()` in
`packages/workflow-engine/src/pipes/utility/index.ts`. Names below are the
palette labels (`metadata().name`).

Palette groups follow the order a pipeline reads — **Trigger, Source,
Transform, Logic, Output** — and every label is unique
(`packages/workflow-engine/src/pipes/catalog.test.ts` enforces both).

| Group | Pipes |
|-------|--------|
| Trigger | Manual, Schedule (run the workflow, call an HTTP endpoint, or **SQL execute**), Webhook, Parent Workflow; Trigger payload |
| Source | SQL query (any FoxSchema dialect); HTTP API, HTTP Multi; CSV file, JSON file, Text file |
| Transform | Map fields, Merge, Split, Script; HTTP lookup; Verify |
| Logic | Condition, Loop, Sub-workflow; Ask a person |
| Output | SQL write (any dialect); Send HTTP request, Workflow response; Write CSV file; Send email, Send SMS |
| *Advanced* (palette toggle) | PostgreSQL / MySQL: stream table (resumable keyset paging) and load table (exactly-once batch claims) |

Condition takes either spelling for its comparison — `operator: 'greaterThan'`
or the `op: 'gt'` that Verify rules and trigger conditions use.

SQL interpolations are **bind parameters**, never text (`{{path}}` in templates;
table/column names are quoted). Each `await`/pipe call uses the drivers the rest
of FoxSchema uses.

Picking a saved connection in a SQL pipe **grants** it: FoxSchema records
`workflow_connection_grants` and the engine credential id `foxschema-{connectionId}`.
The engine resolves that connection **as the owner** through
`WorkflowConnectionGrants.resolveForEngine`. Revoke stops the next run.
The pipe never stores a password.

The engine itself is install-wide (one SQLite file, every designer sees every
workflow). A saved connection is not: it belongs to one workspace. Save, run,
duplicate, read a run, and steering (cancel / resume / answer) all call
`WorkflowConnectionGrants.notUsableBy` on the connections named in the body,
the stored workflow, or the run snapshot (`ENGINE_ROUTES[].connections`). A
connection the caller is not a member of is **403** before the handler runs.
A grant is also ignored once the granter leaves that workspace
(`resolveForEngine`).

### Schedule: SQL execute

A Schedule trigger's **Execution type** can be **SQL execute**. On each fire the
engine runs the script against a saved connection (picked the way SQL pipes pick
one, so the trigger holds a credential id, never a password) and starts the
workflow with the rows the last statement returns — one record per row, into
whatever pipes follow the trigger.

- **Start only when rows are returned** (on by default): an empty result
  creates no run. Off, every fire starts a run; with no rows the pipes get one
  record carrying `scheduledAt` and `rowCount: 0`.
- **Max rows per run** (default 1,000, at most 10,000) caps the payload; the
  run's trigger payload records `rowCount` and `truncated`. It does not limit
  the query: the driver still reads every row the last statement returns, so
  give that statement its own `LIMIT`.
- **Run the script in a transaction**: the run is enqueued before the
  transaction commits, so a run that cannot start (engine disabled, overlap
  refused) rolls the script back instead of losing the rows it moved. Without
  a transaction the script's changes stand and the refusal is reported.
- **Retries** (the schedule's retry policy) cover connecting only. Once a
  statement has been sent, a failure is reported, never retried: running the
  script again could repeat writes that already happened.
- The script may change data; the connection's account is the boundary.
- It runs detached from the scheduler tick, and a fire that comes due while the
  previous one is still running is skipped and reported. With **catch-up: all**
  the occurrences one tick picks up run one after another.

The API Endpoint and API Polling triggers were removed. Use a **Webhook**
trigger (with `?wait=1` for a synchronous answer) for inbound calls. A saved
workflow that still has one loads in the designer without it, with a warning;
remove its trigger pipe and save.

## Steering a run

`workflow.run` starts a job and also steers one that is already going. The
Runs panel (`RunsPanel.tsx`):

| State | Control | Engine route |
|-------|---------|--------------|
| `queued` / `running` | **Cancel run** | `POST /runs/:id/cancel` |
| `paused` (Ask a person) | load the question, **Send answer** | `GET` then `POST /runs/:id/inputs` |
| `paused` | **Resume** without new values | `POST /runs/:id/resume` |

Each of those first reads the run snapshot so the workspace check applies to
what the run actually used, not the live workflow (which may have been edited
since). A start is still refused unless engine state is `enabled`; cancel and
answer are not starts.

## Engine settings

Saved in FoxSchema (`workflow.engine_config`). The in-process engine applies
them on save and re-reads them every **30 seconds**.

| Setting | Default | Meaning |
|---------|---------|---------|
| State | `enabled` | `enabled` admits new runs; `draining` finishes in-flight work (sub-workflows only); `disabled` admits nothing new |
| Max parallel | `4` | Cap on runs executing at once in this process |
| onOverlap | `skip` | `skip` / `queue` / `parallel` when a trigger fires while a run is already active |
| Sinks | all off | Event store (DB), JSON files, text files — file targets are names under `WORKFLOW_LOG_DIR`, never paths |

## Constraints and pitfalls

- **Two encryption keys.** `APP_ENCRYPTION_KEY` protects FoxSchema saved
  connections. `FOXFLOW_ENCRYPTION_KEY` (32 bytes, hex or base64) protects the
  engine credential store and is **required at engine boot** — there is no
  plaintext fallback (`keyFromEnv()`).
- **A connection stays in its workspace.** Linking one in workspace A used to
  let every designer on the install save and run with A's password. The API
  now refuses that. Move the workflow (or re-pick a connection that belongs
  here) instead of copying a `foxschema-…` credential id across workspaces.
- **The rail item is on.** `NAV_FLAGS.workflow === true` puts Workflow on the
  activity rail and the command palette. Accounts without `workflow.access` are
  sent Home (`redirectFor`).
- **Home → Services is status, not control.** `GET /api/system/services` reports
  the API (always `running` if the page loaded) and the in-process engine:
  `running` when `FOXFLOW_ENCRYPTION_KEY` is set and the engine started,
  `not_configured` when the key is missing, or `unreachable` if boot failed.
  A running engine that is Disabled in Workflow settings still reports
  `running`, with `detail` “Not taking new runs”. There is no Start / Stop
  from the card yet ([plan](../plans/2026-11-01-service-status.md)).
- **Docker.** Set `FOXFLOW_ENCRYPTION_KEY` on the FoxSchema process. The image
  defaults `FOXFLOW_DB_PATH` to `/data/workflow-engine.sqlite`. See
  [DEPLOYMENT.md](DEPLOYMENT.md#workflow-engine).
- **Sandbox isolation.** The engine runs in its own child process spawned with
  Node `--permission`, no `--allow-child-process`, no `--allow-worker`, no
  `--allow-addons` by default, a stripped environment (`APP_ENCRYPTION_KEY`,
  `FOXFLOW_ENCRYPTION_KEY`, `SESSION_SECRET`, and `APP_DB_PATH` are excluded from
  `process.env`), a bounded V8 heap (`FOXFLOW_SANDBOX_MEMORY_MB`, default `512`),
  and narrow filesystem access covering only the exact workflow SQLite files
  (`workflow-engine.sqlite*`) and configured `FOXFLOW_FILES_DIR` / `WORKFLOW_LOG_DIR`
  subdirectories — never `/data` root or `foxschema.db`. Only FoxSchema holds
  the private OS IPC channel; standalone execution of the worker is refused.
  `transform.script` still runs in a dedicated zero-FS child sandbox via
  parent reverse-RPC, pure-JS database drivers (Postgres, MySQL, MariaDB, SQL Server,
  Oracle thin, ClickHouse, Redshift, CockroachDB, Yugabyte) run inside the sandbox,
  and native-addon dialects (file-based SQLite, DuckDB, IBM Db2) delegate safely
  over private reverse-RPC to FoxSchema. Every SQLite and DuckDB connection (in
  workflows and across FoxSchema) rejects `foxschema.db`, `workflow-engine.sqlite`,
  and `.app_encryption_key` — including `file:` URIs, `-wal`/`-shm`/`-journal`
  companions, symlinks, and hard links — while DuckDB sessions lock
  `enable_external_access = false` with `lock_configuration = true` (blocking
  `read_text`, `read_csv`, `ATTACH`, and `COPY ... TO/FROM` everywhere except the
  backups folder, `FOX_DUCKDB_BACKUP_DIR`, which the Backup panel exports to) and SQLite sessions
  refuse `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension()`, and schema-safety
  `PRAGMA` overrides. A SQLite step with no credential (or a `:memory:` one) runs
  on built-in `node:sqlite` inside the sandbox, on one in-memory database per
  workflow run: every step and pipeline of the run sees the same tables, and the
  database is closed when the run ends. Plugins require a `@sha256:` digest pin, and an
  unexpected sandbox crash triggers automatic respawn with backoff without taking
  down FoxSchema. Production Docker images pre-build `packages/server/dist/workflow-sandbox.worker.mjs`
  so `node_modules` can stay read-only. The npm CLI ships its own pre-built
  `dist/workflow-sandbox.worker.mjs` beside `ui-server.js` and points
  `FOXFLOW_SANDBOX_WORKER_BUNDLE` at it unless that is already set; the package
  carries no esbuild, so it could not build one at startup. Optional operator knobs:
  `FOXFLOW_SANDBOX_MEMORY_MB`, `FOXFLOW_SANDBOX_ENV_ALLOWLIST`,
  `FOXFLOW_SANDBOX_EXTRA_READ_DIRS`, `FOXFLOW_SANDBOX_EXTRA_WRITE_DIRS`,
  `FOXFLOW_SANDBOX_ALLOW_ADDONS=true`, `FOXFLOW_SANDBOX_WORKER_BUNDLE`, and
  `FOXFLOW_SANDBOX_MODE=in-process` (debug fallback).
- **SQLite and DuckDB sessions share one handle per file.** The adapters cache
  one handle per path and ignore `pooled: false`, so a "dedicated" workflow
  session is not dedicated. `SharedHandleGate`
  (`packages/workflow-engine/src/pipes/db/shared-handle-gate.ts`) makes the other
  sessions on that handle wait while one holds a transaction. Without it, two
  batches reaching one SQLite write pipe at once (a Merge of two sources) failed
  with `cannot start a transaction within a transaction`.
- **Sink batch claims are per run.** Postgres/MySQL write pipes scope the
  idempotency claim to `[workflowRunId, batch.id]` so a retry inside one run
  dedupes, but the next scheduled run is not suppressed.
- **File pipes are confined.** CSV / JSON / text sources, Write CSV file and
  the designer's file preview only touch paths under `FOXFLOW_FILES_DIR`
  (default `workflow-files/` beside the engine database). Designing a workflow
  is an editor permission; without the root an editor could read or write any
  file the engine process can (`pipes/utility/file-root.ts`).
- **Plugin loading** needs both `FOXFLOW_PLUGINS_DIR` and
  `FOXFLOW_PLUGINS_ALLOWLIST` as `name@sha256:<hex>`. Name-only entries are
  ignored. Unapproved plugins are skipped, not fatal.
- **Do not commit** `foxflow.sqlite*` / `workflow-engine.sqlite` / `workflow-files/`.

## Tests

```bash
npx vitest run packages/workflow-engine packages/server/src/features/workflow
npm run test:e2e:workflow    # Playwright smoke (dev servers must be up)
```
