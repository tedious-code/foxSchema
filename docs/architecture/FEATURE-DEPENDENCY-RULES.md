# Feature dependency rules

Which code may import which, and the test that enforces each rule. Layout and
registration are in [FEATURE-MODULE-GUIDE.md](FEATURE-MODULE-GUIDE.md).

## Packages (unchanged)

```text
sql  ←  db         ←  server  ←  web (serving entry only), cli
sql  ←  ui-shared  ←  web (frontend)
sql  ←  shared     ←  server, web, cli
workflow-contract  ←  server, web, workflow-engine, workflow-server
sql, db  ←  workflow-engine  ←  workflow-server
```

Enforced by `packages/sql/src/purity.test.ts`, `packages/shared/src/purity.test.ts`,
`packages/ui-shared/src/ui-shared.test.ts`.

## Server (`packages/server/src`)

```text
api/        Fastify bootstrap, security headers, static assets — no business routes
  ↓
app/        the feature registry: the one place features are composed
  ↓
features/   product features; each exposes index.ts
  ↓
platform/   identity, authorization, settings, connections, workspaces,
            http, guards, contracts, crypto, logger
  ↓
database/   metadata store and migrations
```

1. `platform/` never imports `features/` or `app/`.
2. A feature imports another feature **only through `features/<x>/index.ts`**,
   never a deep path such as `features/git/git-repo.service`.
3. No cycles between features, even through `index.ts`.
4. `api/` declares no business route; it mounts what the registry returns.
5. A feature does not reimplement drivers (`@foxschema/db`) or dialect SQL
   (`@foxschema/sql`); dialect strings go in `packages/sql/src/providers/`.
6. Workspace-owned data is reached through `platform/connections` and the
   services that take a `WorkspaceScope`, never by raw SQL from another feature.

Enforced by `packages/server/src/architecture.test.ts` (step 2).

## Web app (`apps/web/src/frontend`)

```text
App.tsx, app/     shell, settings, the feature registry
  ↓
features/         product features; index.ts and view.ts are public
  ↓
shared/           api client, ui components, lib — product-neutral
```

1. `shared/` never imports a feature.
2. A feature imports another feature only through its `index.ts`.
3. The app shell imports a feature only through `index.ts` or its lazy
   `view.ts` (step 4 tightens this; today the shell still reaches into a few
   feature internals).
4. Nothing imports `@foxschema/db` or `@foxschema/server`; dialect code comes
   from `@foxschema/ui-shared`.

Enforced by `apps/web/src/frontend/architecture.test.ts`.

## When a rule gets in the way

Do not add an exception first. Ask which side the code belongs to:

- Two features need it → move it to `platform/` (server) or `shared/` (web).
- One feature needs another's behaviour → export it from that feature's
  `index.ts`.
- A cycle → one of the two is really platform, or a composition-time hook
  (the registry passes a callback) replaces the import.
