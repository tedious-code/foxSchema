# Service status on Home, with start and stop for the Workflow engine

Board card: `dashboard-service-control`. Decided on 2026-11-01: v1 shows the
status of all three services and lets an admin start and stop the Workflow
engine only.

## What the user sees

A **Services** card on Home with one row per service:

| Service | Status | Reason when not running | Action (with permission) |
|---|---|---|---|
| API | Running (always, since it serves the page) | n/a | none |
| Web UI | Running (the page loaded) | n/a | none |
| Workflow engine | Running · Stopped · Not configured · Unreachable | the engine's last error, or which setting is missing | Start / Stop |

- Blue dot when running, grey when stopped, amber with the reason when it is
  configured but unreachable.
- "Not configured" names what is missing: `WORKFLOW_ENGINE_TOKEN`,
  `FOXFLOW_ENCRYPTION_KEY`, or an engine endpoint in Workflow settings.
- The card refreshes every 10 s while Home is open, plus once when you click it.

## Why only the engine can be started and stopped

- The API serves the button. It cannot restart itself, and a stop button for
  the API would leave no way back from the browser.
- The Web UI is static files the API or Vite serves; there is nothing to stop.
- The engine is a separate process (`apps/workflow-server`). The API can run
  it as a child process.

## How it works

**Status** comes from one new read endpoint, `GET /api/system/services`:

- `api`: `{ state: 'running', version, uptimeSec }`, answered by itself.
- `web`: not reported by the server; the client marks it running.
- `engine`: from what exists today: `WorkflowSettingsService.getConfig()` for
  the endpoint and `enabled | draining | disabled` state, and its `/health`
  probe (`workflow-settings.service.ts`, `GET /api/workflow/engine/health`).
  Plus `managed: boolean`: whether this API started it.

**Start and stop** are `POST /api/system/services/engine/start` and `/stop`:

- Start spawns `apps/workflow-server` (`tsx src/server.ts`, or the built entry
  in a packaged install) with the API's own `WORKFLOW_ENGINE_TOKEN` and
  `FOXFLOW_ENCRYPTION_KEY`, bound to loopback, on the port in the configured
  endpoint. It refuses with a clear message when either variable is missing,
  or when something already answers `/health` at that endpoint.
- Stop sends SIGTERM to the child the API started, then SIGKILL after 10 s.
  An engine the API did not start (run by systemd, Docker or by hand) is shown
  with its status but **no** Stop button, because killing a process we do not
  own is wrong.
- The child stops when the API stops.
- Its stdout and stderr go to the API log under `component: "workflow-engine"`,
  following the logging contract in `docs/BACKEND_ARCHITECTURE.md`.

**Permission:** a new install-wide `admin.services`, which admins have by
default and no workspace role can grant. This is the same pattern as
`admin.drivers` (#546). Without it the card shows status only.

## Out of scope for v1

- Restarting the API, and any supervisor process.
- Starting the engine's separate scheduler and worker entries
  (`start:scheduler`, `start:worker`).
- Remote engines: status works for any endpoint, but start and stop only for
  a loopback endpoint.

## Tests

- **Server:** the status endpoint for each engine state (not configured,
  disabled, unreachable, running), with the health probe stubbed. Start
  refuses without token or key, or when an engine already answers. Stop
  refuses an engine it did not start. Both are refused without
  `admin.services`.
- **Process:** a fake child-process seam (spawn injected), so start, stop and
  the SIGKILL timeout are unit-tested without running a real engine.
- **Web:** the card renders each state; buttons only with the permission.
- **E2E:** start the engine from Home, see Running, stop it, see Stopped.

## Order of work

1. Status endpoint and the Home card, read-only. Shippable on its own.
2. The `admin.services` permission, then start and stop with the process seam.
3. E2E.
