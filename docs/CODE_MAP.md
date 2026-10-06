# Where things live

A map of the repository, and where a change belongs.

## Packages

```
packages/sql                Dialect knowledge: SQL generation, schema compare,
                            statement splitting, type mapping. No dependencies,
                            no Node built-ins — it runs in a browser too.

packages/db                 Database drivers and the connection runtime: connection
                            factory, pooling, circuit breaker. Depends on sql.

packages/shared             Contracts the frontend, server and CLI must agree on:
                            permission names, error codes, wire message shapes,
                            and the COMMUNITY_NAV registry (`nav.ts`). Browser-safe.

packages/workflow-contract  Browser-safe control-plane types for the workflow engine
                            (config, health, sinks, overlap policy), the service
                            token and internal route names, connection-grant types
                            and COMMUNITY_WORKSPACE_ID.

packages/workflow-engine    The workflow engine: definitions, compiler, runtime,
                            SQLite stores, credentials and the built-in pipes
                            (`src/pipes/*`: SQL on every FoxSchema dialect, files,
                            HTTP, email/SMS, control flow). Node only. Depends on
                            sql, workflow-contract and db — db loaded on first use.
                            `src/definitions.ts` is the browser-safe subset.

packages/server             The backend: HTTP layer, feature modules, metadata store.

apps/web                    The frontend, plus the entry point that serves it.
apps/cli                    The `foxschema` command line tool.
apps/workflow-server        The workflow engine's HTTP process (port 8081), plus
                            optional scheduler and worker roles. Its API answers
                            the server's engine proxy (WORKFLOW_ENGINE_TOKEN);
                            trigger ingress can take a port of its own
                            (INGRESS_PORT). Pulls engine settings from the server.
                            Runbook: docs/WORKFLOW.md.
apps/e2e                    Browser tests that drive the running application.
```

Imports may only run in one direction:

```
sql  ←  db      ←  server  ←  web, cli
sql  ←  shared  ←  server, web, cli
workflow-contract  ←  server, web, workflow-engine, workflow-server
sql, db  ←  workflow-engine  ←  workflow-server
```

`packages/sql/src/purity.test.ts` and `packages/shared/src/purity.test.ts`
enforce this. The frontend must never import `@foxschema/db` or
`@foxschema/server`.

### Nav registry — `packages/shared/src/nav.ts`

`COMMUNITY_NAV` is the single source for activity-rail ids and RBAC gating.
`filterNav(items, can, flags)` hides items by permission and optional feature
flags (`workflow`, `enterprise.channels`).

## Dialect knowledge — `packages/sql/src`

```
interfaces/  The shared vocabulary: TableSchema, TableDiff, MigrationStep.
providers/   One folder per dialect — settings, SqlDialect, and Access SQL (`*.user-sql.ts`, `*.access-sql.ts`).
             `dialectFamily()` in `provider-settings.ts` maps wire-compatible
             relatives onto mysql / postgres / sqlserver.
cores/       Connection strings, and shaping catalog rows into TableSchema.
modules/     One folder per domain, named to match the frontend feature
             that consumes it.
```

| Folder | What it covers |
|---|---|
| `dialect` | The `SqlDialect` contract, the registry, type mapping, capability flags |
| `sql-text` | Statement splitting and SQL templating |
| `schema-diff` | Comparing two schemas, and browsing one. `normalizeDefinitionText` is shared with Lokee |
| `migrations` | Generating DDL, ordering drops, validating a plan |
| `lokee-weave` | Content-addressed schema versioning and revert |
| `sql-editor` | FoxScript parsing, code cells, SELECT aliasing, the SQL subset |
| `access` | Permission intent, effective access, GRANT/REVOKE and account DDL (facades; emitters live in `providers/<dialect>`) |
| `utilities` | DBA queries: server insights, index fragmentation |

`dialect` and `sql-text` are the foundations: the other folders build on
them, never the reverse.

Code outside this package imports the `@foxschema/sql` barrel. Module paths
are internal — `exports` in `package.json` maps only `.`, so a deep import
does not resolve.

## Backend — `packages/server/src`

```
api/         The HTTP server itself: Fastify setup, route tree, security
             headers. Nothing business-specific.

platform/    Cross-cutting infrastructure used by every feature.
  contracts/   ActorContext and ServiceError
  guards/      origin policy (`FOX_ALLOWED_ORIGINS`, literal LAN IPs in dev),
               rate limit, idempotency, target locks
  http/        request/response types, router, Fastify binding, responses
  db/          connection resolution
  crypto/      secret encryption
  logger/      logging configuration

features/    One folder per business domain (see below).

internal/    Callable in-process but deliberately not exposed as API:
             driver install, update checks, cloud secrets.

database/    The metadata store and its migrations.
```

### Backend features

| Folder | What it covers |
|---|---|
| `access` | Database permission inspection and DBA utilities |
| `admin` | Install-wide settings, secrets, cloud credentials |
| `auth` | Login, sessions, SSO |
| `authorization` | Role permissions (RBAC) and the permission guard |
| `compare` | Schema comparison |
| `connections` | Saved database connections (`authMethod` / `domain` on encrypted `ConnectionOptions`; NTLM is adapter-side) |
| `data-migrate` | Moving data between databases |
| `files` | File uploads and querying an uploaded file |
| `git` | Git repositories migrations are committed to: bare local copies through isomorphic-git, branches, fetch / pull / push, and the guarded HTTP client that refuses private addresses. Plan: [plans/2026-10-02-migrations-in-git.md](plans/2026-10-02-migrations-in-git.md) |
| `history` | Schema history and revert (Lokee Weave) |
| `import-process` | Parsers, column detection and the worker pool used by imports |
| `migration` | Applying DDL migrations, and their run history |
| `schema` | Reading a schema |
| `sql-editor` | SQL editor, code cells, sandboxed execution |
| `users` | Profile, preferences, first-run wizard |
| `workflow` | Workflow engine settings and health; the engine proxy (an allowlist of engine routes, each behind a `workflow.*` permission); saved-connection grants; and the token-guarded internal routes the engine calls to resolve a granted connection and read its settings. Runbook: [WORKFLOW.md](WORKFLOW.md). |

Inside a feature:

```
*.routes.ts      paths, methods and which guards run
*.guard.ts       admits or refuses a request
*.handler.ts     one endpoint: read the request, call a controller
*.controller.ts  orchestrates services for one feature
*.service.ts     business logic, no HTTP types
*.worker.ts      worker entrypoints — these are loaded by file path,
*-thread.ts      so renaming one needs a matching update at the call site
```

A feature uses the layers it needs; it does not create empty ones.

## Frontend — `apps/web/src/frontend`

```
app/         The application shell, settings screens and global stores.
features/    One folder per business domain.
shared/      Reusable across features: api clients, ui components, lib, utils.
```

Imports may run `app → features → shared`, never `shared → features`.
`architecture.test.ts` enforces it.

### The SQL editor store, and how it is being reduced

`app/store/useSqlEditorStore.ts` is the largest file in the repository and the
most-changed one. It is being shrunk a slice at a time rather than rewritten,
because a file with that much churn is the worst possible candidate for a
big-bang refactor.

The rule, when you touch it: **take one slice of logic that does not need the
store, move it to its own module beside the store, and test it there.** The
store keeps the async orchestration — `get()`, `set()`, API calls — and imports
the pure part. Re-export the moved symbols from the store so existing callers
do not churn.

Done so far:

| Module | Covers |
|---|---|
| `store/sqlEditorTabLogic.ts` | Which statements a run executes, from the caret offset |
| `store/sqlEditorDataPeek.ts` | Peek panel shape, the drill tree, limit clamping, run generations |

Next candidates, roughly in order of how tangled they are: results paging and
the page-epoch guard, bookmarks and recents, SQL variables.

### Frontend features

| Folder | What it covers |
|---|---|
| `access` | Permission builder, inspector and report |
| `admin` | User and role administration |
| `auth` | Sign-in, SSO buttons, onboarding |
| `connections` | Connection modal (login method: password / Windows / LDAP), credential manager, database settings |
| `lokee-weave` | Schema history graph and version compare (Snapshots workspace) |
| `migrations` | Migration run history (Applies on the rail) |
| `object-detail` | Detail panel for a single schema object |
| `schema-diff` | Diff rendering shared by compare and history |
| `sql-editor` | SQL editor, results grid, data peek (Index/Clone/Query files live in `utilities`) |
| `utilities` | Own workspace: clone table, index management, server insights, query files, DB users & grants |
| `workflow` | Workflow designer (canvas, inspector, triggers, SQL and script editors), runs, variables, credentials and engine settings — through the engine proxy, plus linking saved connections to workflows |

## Where does my change go?

| Change | Where |
|---|---|
| New API endpoint | `packages/server/src/features/<domain>/` |
| Dialect-specific SQL | `packages/sql/src/providers/<dialect>/` |
| A new driver | `packages/db/src/providers/<dialect>/` |
| Something the frontend and backend both need | `packages/shared/src/` |
| New screen or panel | `apps/web/src/frontend/features/<domain>/` |
| Reusable UI or helper | `apps/web/src/frontend/shared/` |
| Calling an API endpoint | use `api` from `@/shared/api/client` — never `fetch` directly |
| SQL for permissions or accounts | `packages/sql/src/modules/access/` (facade) + `packages/sql/src/providers/<dialect>/*.user-sql.ts` / `*.access-sql.ts`. Db2 OS-user docker steps: `buildDb2OsUserInstructions`. |
| A dialect capability the app must branch on | `packages/sql/src/modules/capabilities/` (`dialect-features.ts`) and `packages/sql/src/modules/dialect/` |
| Guard or cross-cutting HTTP concern | `packages/server/src/platform/` |
| Workflow pipe, runtime, or store | `packages/workflow-engine/` — HTTP process in `apps/workflow-server/` ([WORKFLOW.md](WORKFLOW.md)) |

## Checks to run

```bash
cd apps/web && npx tsc --noEmit     # typecheck (covers packages too)
npx vitest run                      # all tests, from the repository root
npx eslint .
npm run build -w @foxschema/web     # the bundler catches what tsc cannot
npm run bundle:first-load           # first-visit download vs its budget (after the build)
```

A new static import of something heavy on the first page shows up in
`bundle:first-load`. Load it on demand instead; docs/ARCHITECTURE.md
("Frontend loading and delivery") lists the helpers for each case.

Run `npx vitest run` from the repository root. Running it from `apps/web`
selects a different project configuration and reports failures that are not
real.

## Calling the API from the frontend

Every request goes through one client, so the base URL, the session cookie, the
JSON headers and error handling are applied in a single place:

```ts
import { api } from '@/shared/api/client';

const info = await api.get<UpdateInfo>('/updates/check');
const runs = await api.get<Runs>('/migrations', { query: { limit: 20 } });
const { secret } = await api.post<{ secret: Secret }>('/app-secrets', input);
await api.put(`/connections/${id}`, changes);
await api.delete(`/connections/${id}`);
```

Paths are relative to the API base, so write `/schema/load`, not
`/api/schema/load`.

Options: `query`, `signal`, `headers`, `allowEmpty`, `noStore`.

A failed request throws `ApiError`, carrying `status` and the server's `code`:

```ts
try {
  await api.post('/compare', ref);
} catch (e) {
  if (e instanceof ApiError && e.code === 'unauthenticated') redirectToLogin();
}
```

For responses that are not JSON — a streamed NDJSON migration, a file download
— use `api.raw`, which returns the `Response` untouched.
