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

Enforced by `packages/server/src/architecture.test.ts`.

## Web app (`apps/web/src/frontend`)

```text
App.tsx, app/     shell, settings, the view registry, global stores
  ↓
features/         product features; the files at a feature's root are public
  ↓
shared/           api client, ui components, lib — product-neutral
```

1. `shared/` never imports a feature.
2. Outside a feature, code imports it only through the files at its root
   (`index.ts`, `view.ts`, `toolbar.ts`, `ui.ts`, ...), never a path inside its
   folders. This holds for the app shell and for other features alike, and for
   relative paths as well as `@/` ones. `vi.mock` in a test is exempt: a mock
   has to name the module that defines the export.
3. No static import cycle crosses a feature boundary. Root entries re-export,
   so two features importing each other's entries form a cycle in which one
   module runs before the other has finished. A dynamic `import()` breaks it.
   This is why `features/compare/index.ts` holds only the store: nearly every
   feature imports it, and the toolbar and workspace, which import other
   features, are separate entries.
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
