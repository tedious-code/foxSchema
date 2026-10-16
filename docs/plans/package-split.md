# Restructure plan — splitting the app as it grows

Status: steps 1 and 2 in progress — see Sequencing. Corrections from implementation are
marked inline and dated.

## What the numbers say

Re-measured on `main` at **0.2.34** (the 0.2.16 figures this plan was written against are
superseded; the note under them about directory boundaries was wrong — see Proposal 1):

| Area | Lines | Note |
| --- | --- | --- |
| `packages/core/src/providers` | 7,096 (60 files) | **Mixed**, not Node-only: dialects+settings are pure, adapters+providers are not |
| `packages/core/src/modules` | 10,044 (37 files) | Mostly pure: splitter, dialects, generator, compare |
| `packages/core/src/cores` | 1,026 (8 files) | Mixed: connection-string pure, factory/pool/detector Node |
| `packages/core/src/interfaces` | 338 (5 files) | Types — all pure |
| `apps/web/src/backend` | 10,702 (73 files) | `routes.ts` alone was **838** |
| `apps/web/src/frontend` | 36,766 (140 files) | |
| `apps/cli/src` | 5,854 (76 files) | |

The decisive measurement was not size but **reachability**: the transitive import closure
of `browser.ts` is 55 files / 9,222 lines and pulls in **zero** `node:` built-ins, while
`index.ts` reaches 89 files / 14,977 lines and pulls in `node:fs`, `node:path`,
`node:module`. That is what made membership decidable per file.

**Core has zero runtime dependencies.** Drivers are loaded dynamically and declared
nowhere. So "core is heavy" is not about install weight — it is about *scope*: one
package holds both pure string logic and the entire database driver layer, behind two
entry points (`browser.ts`, 103 export lines; `index.ts`).

A symptom found while measuring, now fixed: `apps/web` aliased `@foxschema/core` to
`browser.ts` in `vite.config.ts` but to `index.ts` in `tsconfig.json`, so the typechecker
and the bundler disagreed about what the name meant. Nothing was broken by it at the time
— every frontend import happened to exist in both — but it is why `npx vitest run` from
`apps/web` left `ConnectionFactory` undefined.

## The contradiction to resolve first

Two requirements were stated together:

1. core should "handle the backend role — play with the database, execute and query"
2. core should be "lightweight so everyone can import it"

**These cannot both hold in one package.** (1) needs Node, drivers, sockets, pooling.
(2) needs browser-safe, zero-dep, tree-shakeable. The current `browser.ts` / `index.ts`
dual entry is a workaround for exactly this tension, and it is already leaking:

- the frontend cannot import `@foxschema/core` directly — it goes through a Vite alias
  to `browser.ts` plus mirror files in `apps/web/src/frontend/lib/`
- FoxFlow needs a hand-written `types/foxschema-core.d.ts` stub because `tsc` would
  otherwise type-check core's source under stricter flags
- under `tsx`, a bare-specifier import of core resolves to an **empty namespace**

Every one of those is a symptom of one package trying to be two.

## Proposal 1 — split core along the seam that already exists

`browser.ts` is already an exact manifest of "the pure half". Promote it to a package.

```
@foxschema/sql     pure, browser-safe, zero deps          (73 files)
  splitter · sql-template · dialects · type-mapping
  compare · sql-generator · code-cell-exec · interfaces
  per-dialect: *.sql-dialect.ts · *.settings.ts · *.connection.ts

@foxschema/db      Node only, depends on @foxschema/sql   (37 files)
  connection-factory · driver-detector · pool-cache
  connection.module · migration.module
  per-dialect: *.adapter.ts · *.provider.ts
```

**Correction (implemented 2026-08-05).** The line above that read
"`providers/*` → db, `modules/*` → sql" was wrong, and it is the one thing that
would have made this look mechanical when it is not. The seam does not follow
directory boundaries — **every dialect directory contributes to both packages**.
`providers/db2/` alone splits 4 files to `sql` and 5 to `db`. The real cut is
*dialect knowledge vs driver execution*, which is a better boundary but requires
per-file assignment, not `git mv` of two directories.

Why this split and not another:

- it is **mechanical in the sense that matters** — the transitive closure of
  `browser.ts` (55 files, 9,222 lines) imports zero Node built-ins, measured, so
  membership is decidable per file rather than argued
- it satisfies both stated requirements without conflict: `@foxschema/sql` is the
  "everyone can import" package; `@foxschema/db` is the "backend role" package
- it deletes the mirror-file convention in `apps/web/src/frontend/lib/` — the frontend
  imports `@foxschema/sql` for real
- publishing becomes honest: `@foxschema/sql` can go to npm immediately (no native
  deps); `@foxschema/db` needs a real release story

**Correction (verified 2026-08-05 — this reverses the previous correction).** A draft
claimed FoxFlow "consumes the driver half, to execute and query", and concluded that
`@foxschema/db` was the package with an external consumer and therefore on the critical
path for npm publishing. That is wrong. Every symbol FoxFlow's stub declares was checked
against both packages:

| FoxFlow uses | lives in |
| --- | --- |
| `SqlDialect`, `CanonicalType`, `CanonicalBase`, `RenderedType` | `sql` |
| `resolveDialect`, `DIALECT_MAP` | `sql` |
| `PROVIDER_SETTINGS`, `getProviderSettings` | `sql` |
| `buildConnectionString`, `DEFAULT_PORTS` | `sql` |
| `CompareModule`, `SqlGeneratorModule` | `sql` |

All 12 are in `@foxschema/sql`; none are db-owned. FoxFlow reuses **dialect knowledge**,
not the driver layer — it brings its own `pg`/`mysql2`. So:

- the package with the external consumer is `@foxschema/sql`, which is zero-dep and
  **publishable to npm today** — no native deps, no peer deps, no release story needed
- the hard packaging problem (native drivers as `optionalDependencies`) is **not** on the
  critical path; `@foxschema/db` can stay an internal workspace package indefinitely
- `apps/cli` is the one consumer that genuinely needs the driver half — it runs migrations

The lesson worth keeping: both drafts asserted FoxFlow's seam from the shape of its
directory name (`packages/pipes/db`) instead of reading what it imports.

Cost, actual: the rename touched 74 import sites across `apps/web`, `apps/cli`, and the
packages themselves, plus 2 tsconfigs, 2 bundler aliases, 2 app manifests — and two
**operational** references that a pure import-rewrite would have missed:
`.github/workflows/version-bump.yml` (bumped `packages/core/package.json`) and
`scripts/sync-public-packages.sh` (mirrored `packages/core` to a public repo). Half a day,
not a day. FoxFlow depends via a `file:` path, so its symlink breaks the moment the
directory is renamed — that repo needs a coordinated change, not a follow-up.

## Proposal 2 — feature modules behind a transport-agnostic service layer

The real obstacle to adding GraphQL is not the absence of a GraphQL library. It is that
`routes.ts` is 834 lines where HTTP parsing, permission checks, and business logic are
interleaved, so there is no layer for a second transport to sit on.

```
apps/web/src/backend/
  features/
    compare/     service.ts  types.ts        (schema diff, migration plan)
    editor/      service.ts  types.ts        (execute, code cells, beam)
    assignment/  service.ts  types.ts        (new)
    admin/       service.ts  types.ts        (users, roles)
  transport/
    rest/        one router per feature, thin
    graphql/     resolvers over the same services  (future)
```

Rule: **a service never sees `req`/`res`.** It takes a typed input plus an
`ActorContext` (`{ userId, role, can(permission) }`) and returns typed output or throws
a typed error. Transports translate.

Two consequences worth stating plainly:

- REST and GraphQL become **two thin adapters over one implementation**, so a permission
  fix lands in both at once. Today's per-statement RBAC check would otherwise have to be
  re-implemented in the GraphQL resolver — and that is exactly how the gaps in #147,
  #152 and #154 appeared.
- Each feature is independently testable without HTTP, which is most of what makes the
  current backend tests awkward.

## Proposal 3 — split the frontend by feature, not by file type

`TableBlueprintModal.tsx` at 2,975 lines and `useSqlEditorStore.ts` at 2,130 are the
maintenance cost. The store in particular is one object holding tabs, results, variables,
bookmarks, secrets, schema cache, data peek, and beam.

```
frontend/features/
  compare/    components/  store/
  editor/     components/  store/   (split the store per concern)
  admin/      components/  store/
frontend/shared/            grid · monaco · ui primitives
```

Do this **last**. It is the largest change and the least urgent — a big React file is
annoying, a leaky package boundary is structural.

## Sequencing

Ordered by (value ÷ risk), each step independently shippable and revertible:

| # | Step | Status | Why here |
| --- | --- | --- | --- |
| 1 | Split `@foxschema/sql` out of core | **done** (2026-08-05) | Unblocks everything else; also fixed the vite/tsconfig alias divergence |
| 2 | Extract `features/*/service.ts`, leave REST as-is | **started** — `actor.ts`, `connections/resolve.ts`, `compare/` | Pure refactor, no API change, makes #3 trivial |
| 3 | Add the GraphQL transport | next | Now genuinely additive — resolvers over existing services |
| 4 | Split the editor store by concern | later | Highest churn area; do it once the boundaries above are stable |
| 5 | Split the frontend by feature | later | Cosmetic relative to 1–3 |

## Guardrails to add alongside

Three of the bugs found this week were boundary failures that a rule would have caught:

- ~~**`import/no-restricted-paths`** — forbid `@foxschema/sql` importing anything Node.~~
  **Done differently.** `packages/sql/src/purity.test.ts` asserts it instead: no `node:`
  imports, no dependency back on `db`, no runtime deps. A test beat a lint rule here
  because the root `eslint.config.js` deliberately runs security rules only, so adding
  `import/*` would have meant adopting a plugin the config had reasons to avoid. Still
  worth a rule for `frontend/**` importing `backend/**`, which nothing checks yet — though
  the frontend half is now enforced by omission: `@foxschema/db` is not aliased in
  `vite.config.ts`, so importing the driver layer fails the build.
- **A shared `hasOwn` helper.** The `beamDialects['toString']` bug and the earlier
  `setBinding` duplicate-binding bug were the same defect twice. A helper plus
  `no-prototype-builtins` is cheaper than fixing it a third time.
- **Make the gates non-bypassable.** #158 merged with two TS errors and two failing
  tests. Whatever the structure, that is the failure that costs the most. Note the
  ESLint security job is currently **red on `main`** for an unrelated reason (a disable
  comment naming a `react-hooks` rule the root config never registers), which is how a
  gate stops being a gate — people learn to ignore it.

## Assignment = scheduled workflows (cron) under RBAC

Clarified after the first draft. This changes where the feature sits and raises one
question that must be settled before any code.

### The hard part is not cron. It is *whose permissions a job runs with*.

Every check in the system today resolves against a **live request**: `authed.appRole`,
`authed.permissions`, `resolveRef(userId, …)`. A job that fires at 03:00 has no request
and no session. So the actor has to come from somewhere, and the choice is consequential:

| Option | Behaviour | Problem |
| --- | --- | --- |
| **A. Freeze at create time** — store the creator's permissions with the job | Fast, no lookup | A user demoted from owner to viewer, or **disabled, or deleted**, keeps executing owner-level SQL forever. Privilege escalation through time. |
| **B. Re-resolve at fire time** from the creator's *current* role | Demotion takes effect on the next run | Needs a defined behaviour when the creator is gone: fail the run, or disable the job |
| **C. Dedicated service principal** per job, assigned by an admin | Clean audit story, independent of staff churn | Another identity to manage; overkill until there are many jobs |

**Recommend B**, with the job recording `created_by` and re-resolving on every fire:

- creator disabled or deleted → job is **suspended**, not silently skipped, and surfaces
  in the job list with a reason
- creator demoted → the run fails the same per-statement gate a live request would hit,
  and the failure is recorded on the run
- this makes the enable/disable + permanent-delete work discussed earlier a hard
  dependency: deleting a user must decide the fate of their jobs

Option A is the one to avoid. It is the default people reach for, and it quietly turns
"remove someone's access" into a lie.

### Credentials are a real constraint, not a detail

`resolveRef` merges a **session password** for connections saved without one. A job at
03:00 has no session. So either:

- assignments are restricted to connections saved **with** a stored password, and the UI
  says so at create time (recommended — explicit and safe), or
- a per-assignment credential is captured at create time and encrypted alongside it,
  which widens what the secrets vault must protect

Silently failing at 03:00 because a password was never stored is the outcome to design
out.

### Where it lands in the structure

- `features/assignment/service.ts` — CRUD, validation, next-run preview
- a **separate scheduler process**, not a `setInterval` in the API. The API restarts on
  self-update (`scheduleUiRelaunch`) and can run multiple instances; both drop timers or
  double-fire. A scheduler needs a durable claim (row-level lease) so two instances
  cannot run the same job twice.
- runs go through the **same** `features/editor/service.ts` path as a live request, so
  the per-statement dml/ddl/grant gate applies unchanged. A second execution path is
  exactly where the gaps in #147/#152/#154 came from.

New permissions: `assignment.view`, `assignment.create`, `assignment.run`,
`assignment.manage` (others' jobs). A job can never exceed its creator's grants — the
invariant to test first.

### Overlap with FoxFlow — decide deliberately

FoxFlow already **is** a workflow engine with cron triggers, reusing `@foxschema/core`:
cron trigger schema with timezone and `executionType`, `cron-parser` next-run previews,
catch-up and overlap policy, a scheduler app, run/checkpoint state.

Building a second scheduler in FoxSchema duplicates that. Three honest options:

**Decided: the products stay separate.** FoxSchema does not depend on FoxFlow at
runtime, and FoxFlow keeps consuming `@foxschema/db` rather than rewriting a driver
layer. Assignment is therefore built in FoxSchema, narrow by design.

The boundary, written down so it can be defended:

> A FoxSchema **assignment** is *one saved script, one schedule, one connection*.
> It has no branching, no fan-out, no inter-step data passing, and no retry graph.
> The moment a requirement needs any of those, it is a FoxFlow workflow, not an
> assignment.

Concretely in scope: cron expression + timezone, a saved script (or a generated
migration), one target connection, on/off, run history with per-statement results,
overlap policy (skip if still running).

Concretely out of scope: multiple steps, conditional edges, passing rows between steps,
external triggers (webhook/pubsub), fan-out across connections. Server Beam's two-endpoint
`sql.on` already covers the one cross-server case that matters, inside a single script.

The relationship runs one way: **FoxFlow depends on FoxSchema's db package; FoxSchema
never depends on FoxFlow.**

## Open questions

1. ~~**Package naming.**~~ **Settled 2026-08-05:** `@foxschema/sql` + `@foxschema/db`,
   and `@foxschema/core` retired. Chosen over keeping `core` for one half, which would
   have left an existing import silently meaning something new.
2. **What is "assignment"?** Named as a target but does not exist yet. Its data model
   decides whether it is a peer feature or part of admin.
3. ~~Does the CLI take `@foxschema/db` or talk to the API?~~ **Settled, but not as
   written above.** `apps/cli` imports the driver layer directly (it runs migrations), so
   it takes `@foxschema/db` — as a workspace package, which needs no publishing. FoxFlow
   turned out to need `@foxschema/sql` only (see the correction in Proposal 1), and that
   package is zero-dep and publishable today. **The native-driver packaging story is
   therefore off the critical path**, reversing the previous conclusion.
4. **GraphQL scope.** Read-only projection over compare/editor results, or full mutation
   parity with REST? The first is a weekend; the second doubles the RBAC surface.
5. ~~**FoxFlow's `file:` dependency.**~~ **Repointed 2026-08-05** to `packages/sql`
   (11 files + the `.d.ts` stub renamed); FoxFlow's gates are green. The `file:` link and
   the stub still exist, but they no longer have to: `@foxschema/sql` is now
   **publish-ready** (`npm run publish:sql`), and a consumer typechecks against the real
   shipped declarations under `moduleResolution: nodenext` with `skipLibCheck: false` —
   verified against a packed tarball in a clean project. Publishing lets FoxFlow drop the
   `file:` dep, the 44-line stub, both `paths` entries, and the "clone it beside this
   repo" error message in one change.
6. **The public `foxschema-core` mirror repo.** No longer a sync target. Archive it, or
   repoint it at one of the new packages.
