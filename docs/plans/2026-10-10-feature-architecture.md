# Feature-oriented architecture — schedule (2026-10-10)

Implements `FOXSCHEMA_FEATURE_ARCHITECTURE_PLAN.md` (the target plan) against the
repository as it is today. The user accepted a risky restructure where it ends
clean. Each step below is one PR: build, test, fix, review, merge, in order.

**Status: approved schedule, in progress.**

## 1. What exists today (verified, Phase 0)

### Already in place

| Target-plan item | Today |
|---|---|
| Feature folders, frontend | `apps/web/src/frontend/features/<f>/`, 14 features, every one with `index.ts` |
| Feature folders, server | `packages/server/src/features/<f>/`, 18 features |
| Frontend import boundaries | `apps/web/src/frontend/architecture.test.ts`: `app → features → shared`, one feature reaches another only through its `index.ts` |
| Package boundaries | `packages/sql/src/purity.test.ts`, `packages/shared/src/purity.test.ts`, `ui-shared.test.ts`: sql pure, frontend never imports db/server |
| Nav + permission registry | `packages/shared/src/nav.ts` `COMMUNITY_NAV` + `filterNav` |
| Platform layer, server | `packages/server/src/platform/{contracts,http,guards,db,crypto,logger}` |
| Error contract | `ServiceError` + `sendError`; every 4xx carries `{ ok, error, code }` (asserted by `api/http-contract.test.ts`) |
| Route regression net | `api/http-contract.test.ts` lists every route with its empty-body status (136) |
| Naming rules | `docs/CONVENTIONS.md`, enforced by `packages/shared/src/naming.test.ts` |

### Gaps against the target plan

**Server**

1. **No feature registry; routes are registered in two places.** `api/server.ts`
   mounts 15 routers by hand, `api/routes.ts` (453 lines) mounts 7 more and
   holds ~10 inline business routes (updates, app info, metadata-DB test,
   driver check/install, connection test, activity, file browse). `api/` is
   documented as "nothing business-specific".
2. **Every server feature reaches into another feature's internals.** No
   server feature has an `index.ts`. Measured edges:
   - 15 features import `auth/auth.routes` — only for `AuthedRequest`, which
     is actually declared in `platform/http/types`.
   - 13 import `authorization/rbac.guard` — a cross-cutting guard.
   - `admin/app-settings.service` is used by auth, users, workflow.
   - `connections/connection-store.service` by files, workflow, `api/`, CLI.
3. **Feature-level import cycles** (the plan's rule 7):
   - identity cluster: `auth ↔ admin ↔ authorization ↔ users ↔ workspaces`
   - `connections ↔ files ↔ import-process`
4. **Platform capabilities live as features**: identity (auth service,
   sessions, guards), authorization (RBAC, admin policy), install settings,
   saved connections, workspace scope. The target plan lists all of these as
   platform.

**Frontend**

5. **No feature registry; a view is wired in five places**: `ActiveView`
   (`app/store/uiStore.ts`), `app/shell/viewLoaders.ts`, `App.tsx` (lazy
   imports + a ternary chain + permission redirects), `ActivityRail.tsx`
   (nav id → view mapping, icons, prefetch).
6. **Feature state and screens live in `app/`**: `useSqlEditorStore.ts`
   (largest file in the repo) + `sqlEditor*.ts`, `useSyncStore.ts` +
   `sync-*.ts`, `shell/TopToolbar.tsx` (the Compare toolbar). The app layer
   imports ~25 feature-internal paths.
7. **Compare has no frontend feature.** Its UI is spread across `app/store`,
   `app/shell/TopToolbar`, `features/schema-diff`, `features/object-detail`.

### Persistence ownership

Each table has one owning feature, except the identity tables (`users`,
`sessions`, `user_preferences`, `app_settings`), read by several — consistent
with identity being platform. Migrations stay in
`packages/server/src/database/schema.ts` (append-only, one numbered list);
ownership is documented, not split into per-feature files (splitting would
reorder migration history for no behaviour gain).

### Baseline (main @ 0.2.310)

typecheck 0 errors · ESLint clean · security lint clean · 6043 unit tests pass
· first load within the 170 KB budget · e2e suites green on the dev server.

## 2. Decisions

- **Keep the modular monolith and the existing package split.** No new
  packages, no runtime plugin loading (target plan non-goals).
- **"Install a feature" = add a folder and one line in a static, typed
  registry** — server and frontend — plus a scaffold command that writes
  both. No filesystem discovery, no dynamic `import()` of unknown code.
- **Server layering:** `api/` (Fastify bootstrap only) → `app/` (the feature
  registry, the one composition point) → `features/*` → `platform/*` →
  `database/`. `platform/` never imports a feature. A feature imports
  another feature only through `features/<x>/index.ts`. No cycles.
- **Platform capabilities move to `platform/`**: `identity` (auth service,
  sessions, auth guard, mail, sign-in settings), `authorization` (RBAC,
  permission guard, admin policy), `settings` (app settings store),
  `connections` (saved-connection store, resolver), `workspaces` (scope
  resolution). HTTP routes for them stay in features (`auth`, `admin`,
  `connections`, `workspaces`), which then are thin.
- **`import-process` merges into `files`** (it is the import machinery of
  that feature; the cycle disappears).
- **Routes keep their exact paths, methods, guards and statuses.**
  `http-contract.test.ts` (136 routes) is the net for every server step.
- **Frontend registry** derives `ActiveView`, the lazy views, prefetch, rail
  items and permission redirects from one list. Each feature exposes a lazy
  entry `features/<f>/view.ts` next to `index.ts`; the app shell imports
  only those two.
- **Feature state moves into its feature**: the SQL editor store into
  `features/sql-editor/state/`, the compare store and toolbar into a new
  `features/compare/`. Old paths are not kept as re-export shims.

## 3. Schedule

| # | PR | Scope | Risk |
|---|---|---|---|
| 0 | **Plan + guides** | This schedule; `docs/architecture/FEATURE-MODULE-GUIDE.md`; `docs/architecture/FEATURE-DEPENDENCY-RULES.md` | none |
| 1 | **Server platform extraction** | Move identity, authorization, settings, connections store/resolver, workspace scope into `platform/`; merge `import-process` into `files`; break both cycles; fix `AuthedRequest` imports. Paths of moved files change; behaviour does not. | high (many imports) |
| 2 | **Server feature registry** | `app/feature-registry.ts` + `ServerFeatureModule`; every feature gets `index.ts` exporting its module and public API; `api/server.ts` builds the tree from the registry; `api/routes.ts` inline routes move into features (`system`, `connections`, `files`); boundary test (no deep cross-feature imports, platform never imports features, no cycles, api has no business routes) | high |
| 3 | **Frontend feature registry** | `app/features/registry.ts`; `view.ts` lazy entries; App/ActivityRail/viewLoaders/uiStore read the registry; test that every registered view loads and every rail id is registered | medium |
| 4 | **Frontend feature state** | Move SQL editor store → `features/sql-editor/state/`, compare store + toolbar → `features/compare/`; app layer imports only `index`/`view`; tighten `architecture.test.ts` | high (largest file) |
| 5 | **Install new features** | `npm run feature:new <id>` scaffolds a server module + frontend feature + tests and registers both; registry ↔ folder consistency tests; guide checklist | low |
| 6 | **Docs + final verification** | `ARCHITECTURE.md`, `CODE_MAP.md`, `CONVENTIONS.md`, `AGENTS.md` pointers; full gates; e2e on the dev server and a fresh install | low |

Per PR: typecheck, ESLint (+security), full `vitest run`, contract test,
`npm run test-ids`, web build + first-load budget, the relevant e2e suites
against the dev server, a code review, then merge after CI.

## 4. Risks and how each is contained

- **Moved files break imports silently** — TypeScript catches every
  unresolved path; the full suite runs on each PR.
- **A route changes path, guard or status** — `http-contract.test.ts`
  asserts all 136; the registry must produce the identical list (a test
  compares registry output to the contract table).
- **Workers loaded by file path** (`*.worker.ts`, `*-thread.ts`) break when
  moved — `import-process` workers move with their callers; the file-import
  e2e (`sql-editor-sqlite`) and worker unit tests cover them.
- **Bundle regressions from barrels** — lazy entries are separate `view.ts`
  files, not the `index.ts` barrel; first-load budget checked on PRs 3–4.
- **Memory/doc references to old paths go stale** — PR 6 updates docs;
  `doc-paths.test.ts` fails on any doc citing a missing path.
- **The CLI imports server internals** (`@foxschema/server` exports) — the
  package entry `packages/server/src/index.ts` keeps exporting the same
  names from their new homes.

## 5. Definition of done

The target plan's §12, checked by tests where possible: feature registry is
the only composition point (test), no deep cross-feature imports and no cycles
(test, both sides), platform never imports features (test), all 136 routes
unchanged (contract test), a new feature is one command plus its code
(scaffold + test), docs updated (doc-paths test).
