# Workflow engine

FoxSchema designs and administers workflows in the web UI. A **separate process**
(`apps/workflow-server`) runs them, so a slow or failing job never shares a
process with Schema Sync or the SQL Editor.

User walkthrough: [USER_GUIDE.md](USER_GUIDE.md#workflow). Deploy env vars:
[DEPLOYMENT.md](DEPLOYMENT.md#workflow-engine). Folder map: [CODE_MAP.md](CODE_MAP.md).

## Architecture

```
Browser  ── /api/workflow/* (session + RBAC) ──►  FoxSchema API  (:3210)
                                                    │ Bearer WORKFLOW_ENGINE_TOKEN
                                                    ▼
                                          workflow-server (:8081 /api/*)
                                                    │ packages/workflow-engine
                    ┌───────────────────────────────┼──────────────────────────┐
                    │                               │                          │
              optional scheduler              SQLite FOXFLOW_DB_PATH     /api/hooks/*
              + worker processes              (repo-root default)        (public ingress)
                    │
                    └── Bearer token ──► FoxSchema /api/workflow-internal/*
                                         (engine-config, connections/resolve)
```

| Piece | Role |
|-------|------|
| `apps/web/src/frontend/features/workflow` | Designer, runs, credentials, Engine control plane |
| `packages/server/src/features/workflow` | Session-gated proxy (`ENGINE_ROUTES`), connection grants, saved engine settings |
| `apps/workflow-server` | Fastify HTTP process: API, optional scheduler/worker roles, trigger ingress |
| `packages/workflow-engine` | Definitions, compiler, runtime, SQLite stores, built-in pipes |
| `packages/workflow-contract` | Browser-safe types, token env name, internal route paths |

The proxy is the only door the designer uses. Webhook and API-endpoint **ingress
is never fronted** by a FoxSchema session — those routes authenticate their own
callers (`apps/workflow-server/src/app.ts`).

Saving a workflow runs the same checks the executor will: every pipe must be
usable, and every edge `fromPort` must be a port the source pipe declares
(`assertKnownFromPorts` in `packages/workflow-engine/src/runtime/ports.ts`,
called from `apps/workflow-server/src/routes/workflows.ts`). An unknown port is
refused at save (`pipeline p: edge split → out: unknown fromPort "eu"`), not
discovered when a scheduled run fails. Pipes without static metadata skip the
check (Goto).

Without `WORKFLOW_ENGINE_TOKEN`, the engine API stays open (loopback dev only)
and FoxSchema's internal resolve route returns 503, so saved connections cannot
be used by workflows.

## Local development

`npm run dev` does **not** start the engine. Use:

```bash
export WORKFLOW_ENGINE_TOKEN="$(openssl rand -hex 32)"   # same value on both processes
export FOXFLOW_ENCRYPTION_KEY="$(openssl rand -hex 32)"  # 32 bytes, hex or base64; required at engine boot
npm run dev:with-workflow
```

That starts three processes (`apps/web/package.json` `dev:all:workflow`):

| Process | Default |
|---------|---------|
| FoxSchema API | http://127.0.0.1:3210 |
| Vite UI | http://localhost:5173 |
| Workflow engine | http://127.0.0.1:8081 |

Or start the engine alone: `npm run dev:workflow-server` (`tsx watch`, port **8081**).

Then in the UI: **Workflow → Engine → Enabled → Save settings**. Saved default
is `disabled` (`packages/server/src/features/workflow/workflow-settings.service.ts`), so new runs
are refused until you enable it. Health probe: `GET http://127.0.0.1:8081/health`
→ `{ ok: true, service: "workflow-server" }`.

## Process roles

All roles share one SQLite file. The default path is **repo-root**
`workflow-engine.sqlite`, not `process.cwd()` — each `npm -w` script has a
different cwd, and a relative default would split-brain
(`packages/workflow-engine/src/storage/database-path.ts`). Set `FOXFLOW_DB_PATH`
to override.

| Role | Script | Behavior |
|------|--------|----------|
| **server** (default) | `npm -w @foxschema/workflow-server run dev` / `start` | Full API + cron/poll + inline execution |
| **scheduler** | `npm -w @foxschema/workflow-server run start:scheduler` | Admits cron/poll; queues runs (`executeInline: false`) |
| **worker** | `npm -w @foxschema/workflow-server run start:worker` | Claims queued runs every `FOXFLOW_WORKER_POLL_MS` (default 2000 ms) |

Queued-run claim is a single-row `UPDATE … WHERE status = 'queued'` — exactly
one worker wins (`claimQueuedRun`).

Graceful shutdown (server): SIGTERM/SIGINT/SIGHUP close ingress first, then the
API (cron/poll stop, scheduler drain ≤2 s, SQLite close). Cap:
`FOXFLOW_SHUTDOWN_TIMEOUT_MS` (default **3000**). Fastify uses
`forceCloseConnections: true` so run-event SSE cannot hang `close()`.

## Permissions

Same four names on the activity rail, workspace tabs, and proxy allowlist
(`packages/shared/src/permissions.ts`, `packages/shared/src/nav.ts`):

| Permission | Who (defaults) | What |
|------------|----------------|------|
| `workflow.access` | viewer+ | Open Workflow; list workflows/runs; read pipe catalog |
| `workflow.design` | editor+ | Designer, variables, credentials list; grant a saved connection |
| `workflow.run` | editor+ | Start / cancel / resume runs (refused unless engine state is `enabled`) |
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
| Trigger | Manual, Schedule, Webhook, API Endpoint, API Polling, Parent Workflow; Trigger payload |
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
`POST /api/workflow-internal/connections/resolve`. Revoke stops the next run.
The pipe never stores a password.

## Engine settings

Saved in FoxSchema (`workflow.engine_config`). The engine re-reads them every
**30 seconds**. If FoxSchema is unreachable it keeps the last known values
(no fail-open).

| Setting | Default | Meaning |
|---------|---------|---------|
| State | `disabled` | `enabled` admits new runs; `draining` finishes in-flight work (sub-workflows only); `disabled` admits nothing new |
| Endpoint | `http://127.0.0.1:8081` | Where the proxy forwards |
| Max parallel | `4` | Cap **per engine process** (two workers each honor it independently) |
| onOverlap | `skip` | `skip` / `queue` / `parallel` when a trigger fires while a run is already active |
| Sinks | all off | Event store (DB), JSON files, text files — file targets are names under `WORKFLOW_LOG_DIR`, never paths |

## Constraints and pitfalls

- **Two encryption keys.** `APP_ENCRYPTION_KEY` protects FoxSchema saved
  connections. `FOXFLOW_ENCRYPTION_KEY` (32 bytes, hex or base64) protects the
  engine credential store and is **required at engine boot** — there is no
  plaintext fallback (`keyFromEnv()`).
- **Docker image does not start the engine.** `Dockerfile` / `docker-compose.app.yml`
  run FoxSchema only. Deploy `apps/workflow-server` beside it and set the token
  on both. See [DEPLOYMENT.md](DEPLOYMENT.md#workflow-engine).
- **Sink batch claims are per run.** Postgres/MySQL write pipes scope the
  idempotency claim to `[workflowRunId, batch.id]` so a retry inside one run
  dedupes, but the next scheduled run is not suppressed.
- **File pipes are confined.** CSV / JSON / text sources, Write CSV file and
  the designer's file preview only touch paths under `FOXFLOW_FILES_DIR`
  (default `workflow-files/` beside the engine database). Designing a workflow
  is an editor permission; without the root an editor could read or write any
  file the engine process can (`pipes/utility/file-root.ts`).
- **Plugin loading** needs both `FOXFLOW_PLUGINS_DIR` and
  `FOXFLOW_PLUGINS_ALLOWLIST`. Unapproved plugins are skipped, not fatal.
- **Do not commit** `foxflow.sqlite*` / `workflow-engine.sqlite` / `workflow-files/`.

## Tests

```bash
npx vitest run packages/workflow-engine apps/workflow-server packages/server/src/features/workflow
npm run test:e2e:workflow    # Playwright smoke (dev servers must be up)
```
