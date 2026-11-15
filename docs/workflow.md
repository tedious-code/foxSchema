# Workflow engine

FoxSchema designs and administers workflows in the web UI. The engine runs
**in the FoxSchema API process** (`packages/server/src/features/workflow/runtime`).

User walkthrough: [user-guide.md](user-guide.md#workflow). Deploy env vars:
[DEPLOYMENT.md](DEPLOYMENT.md#workflow-engine). Folder map: [CODE_MAP.md](CODE_MAP.md).

## Architecture

```
Browser  ── /api/workflow/* (session + RBAC) ──►  FoxSchema API  (:3210)
                                                    │ in-process Engine
                                                    ▼
                                          packages/workflow-engine
                    ┌───────────────────────────────┼──────────────────────────┐
                    │                               │                          │
              scheduler + cron/poll           SQLite FOXFLOW_DB_PATH     /api/hooks/*
              (same process)                  (repo-root default)        (public ingress)
```

| Piece | Role |
|-------|------|
| `apps/web/src/frontend/features/workflow` | Designer, runs, credentials, Engine control plane |
| `packages/server/src/features/workflow` | Settings, connection grants, `ENGINE_ROUTES` Fastify plugins |
| `packages/server/src/features/workflow/runtime` | Engine host, Fastify route plugins, SQL probe |
| `packages/workflow-engine` | Definitions, compiler, runtime, SQLite stores, built-in pipes |
| `packages/workflow-contract` | Browser-safe types |

The designer talks to `/api/workflow/engine/*` with a FoxSchema session.
Webhook and API-endpoint **ingress is never fronted** by that session — those
routes authenticate their own callers (`runtime/routes/triggers.ts`).

Saving a workflow runs the same checks the executor will: every pipe must be
usable, and every edge `fromPort` must be a port the source pipe declares
(`assertKnownFromPorts` in `packages/workflow-engine/src/runtime/ports.ts`,
called from `packages/server/src/features/workflow/runtime/routes/workflows.ts`). An unknown port is
refused at save (`pipeline p: edge split → out: unknown fromPort "eu"`), not
discovered when a scheduled run fails. Pipes without static metadata skip the
check (Goto).

Saved FoxSchema connections resolve in-process through
`WorkflowConnectionGrants.resolveForEngine` (injected into the Engine). There
is no service token and no second hop.

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
  from the card yet ([plan](plans/2026-11-01-service-status.md)).
- **Docker.** Set `FOXFLOW_ENCRYPTION_KEY` on the FoxSchema process. The image
  defaults `FOXFLOW_DB_PATH` to `/data/workflow-engine.sqlite`. See
  [DEPLOYMENT.md](DEPLOYMENT.md#workflow-engine).
- **In-process isolation.** A hung SQL or script shares this API process.
  Mitigations: script pipes still run on worker threads; a bad
  `FOXFLOW_ENCRYPTION_KEY` does not take down the API; saved-connection
  resolve is injected (no HTTP to this process); HTTP pipes refuse loopback
  and link-local; plugins load only with a digest pin.
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
