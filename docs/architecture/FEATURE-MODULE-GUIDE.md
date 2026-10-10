# Feature module guide

How a FoxSchema feature is laid out, registered and tested — on the server
and in the web app. The rules that keep features apart are in
[FEATURE-DEPENDENCY-RULES.md](FEATURE-DEPENDENCY-RULES.md).

> Status: being introduced by the series in
> [../plans/2026-10-10-feature-architecture.md](../plans/2026-10-10-feature-architecture.md).
> Each section says which step makes it true.

## What counts as a feature

A **feature** is a product domain a user can name: Compare, Editor, Access,
History, Utilities, Workflow, and the smaller ones (Git, Backup, Files…).
A **platform capability** is something every feature needs and no user asks
for by name: identity and sessions, authorization, install settings, saved
connections, workspace scope, HTTP plumbing, logging, crypto. Capabilities
live in `platform/`; features live in `features/`.

If you are unsure: if two features would each need it, it is platform. If it
only makes sense inside one screen or one API area, it is that feature's.

## Server feature (`packages/server/src/features/<id>/`)

```text
features/<id>/
  index.ts              public surface: the module, and anything other features may call
  <id>.routes.ts        paths, methods, guards — no business decisions
  <id>.service.ts       use cases; no HTTP types
  <subject>.<role>.ts   more files by role as the feature grows (see docs/CONVENTIONS.md)
  *.test.ts             beside what they test
```

Use the layers you need; do not create empty ones. Split a growing service by
use case (`compare-schemas.service.ts`, `apply-migration.service.ts`), not by
abstract layer.

**`index.ts` exports a `ServerFeatureModule`** (step 2):

```ts
// features/backup/index.ts
import type { ServerFeatureModule } from '../../app/feature-module';
import { createBackupSettingsRoutes } from './backup-settings.routes';

export const backupFeature: ServerFeatureModule = {
  id: 'backup',
  mounts: [{ prefix: '/api/backup-settings', access: 'user', routes: () => createBackupSettingsRoutes() }],
};
```

- `access` is one of `public`, `user` (signed in), `registered` (signed in
  with a real account, not a launch link), `internal` (the workflow engine's
  service token). The registry turns it into the guard chain; a feature never
  wires the session guard itself.
- Permission checks stay on each route: `requirePermissions('…')` from
  `platform/authorization`. Visibility in the UI is never authorization.
- `routes` receives a typed `FeatureContext` (the shared connection module,
  connection store, resolver) — never a global container.

**Register it** by adding one line to `app/feature-registry.ts`. That list is
the only composition point; nothing registers itself on import.

## Web feature (`apps/web/src/frontend/features/<id>/`)

```text
features/<id>/
  index.ts        public surface for other features and the app shell
  view.ts         the lazy entry: the screen the app loads on demand (step 3)
  components/     feature-private components
  api/            calls the server through `api` from @/shared/api/client; no business rules
  state/          only when the feature needs shared or persistent state (step 4)
  lib/            feature-private helpers
```

**A workspace view is registered** in `app/features/registry.ts` (step 3):

```ts
{
  id: 'utilities',            // the ActiveView value
  label: 'Utils',
  icon: Wrench,
  permission: 'utility.access',
  load: () => import('@/features/utilities/view'),
}
```

The rail, the lazy view, prefetch-on-hover and the "you lost access, go home"
redirect all read this entry. Adding a view touches no shell file.

Keep components local until a second feature needs them; then move the
product-neutral part to `shared/`, not to another feature.

## Adding a feature

```bash
npm run feature:new -- <id>        # step 5: scaffolds both sides and registers them
```

Then fill in the service, the routes and the screen. The checklist below is
what review looks for.

## Acceptance checklist

- [ ] Server validates every input (`invalid_input` with a sentence, never a 500).
- [ ] Every protected route has its `access` level and a `requirePermissions` check.
- [ ] No secret is returned or logged (passwords, tokens, connection strings).
- [ ] Errors use `ServiceError` / `sendError`; the HTTP contract test lists the new routes.
- [ ] Workspace-owned rows are read and written through a `WorkspaceScope`.
- [ ] Unit tests for the service, route tests for guards and statuses, a component test for the screen; A/B each new test (break the code, see it fail).
- [ ] Persistence changes are a new numbered migration in `database/schema.ts` (append-only).
- [ ] `npm run test-ids` after any JSX change; new controls have test IDs.
- [ ] Typecheck, lint, the full suite and the web build (with the first-load budget) pass.
- [ ] Docs: the feature's row in `docs/CODE_MAP.md`.
