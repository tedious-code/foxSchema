# Backend architecture — state, decisions, and what to do next

Written for whoever picks this up next, human or agent. It records what the
backend *is*, why it is that way, and which of the plan's ideas were tried and
rejected — so the same ground is not re-covered.

Companion to `IMPLEMENTATION_STATE.md` (feature-level handoff) and
`docs/ARCHITECTURE.md` (repo layout, dialect system).

---

## 1. The package split, and what it maps to

The reference plan proposes `api / core / database / shared`. This repo already
has an equivalent split under different names, enforced by
`packages/sql/src/purity.test.ts`:

| Plan | This repo | Contains |
|---|---|---|
| `@foxschema/core` | `@foxschema/sql` | Dialect knowledge, compare, SQL generation, access model. **Zero deps, no Node built-ins.** |
| `@foxschema/database` | `@foxschema/db` | Drivers, pools, connection factory, circuit breaker. Depends on `sql`. |
| `@foxschema/api` | `packages/server` | HTTP, auth, routes. |
| `@foxschema/shared` | — | Not separate; shared types live in `sql`. |

**The dependency rule is one-way and tested**: `sql` never imports `db`; the
frontend imports `sql` only, and importing `db` from the frontend fails the Vite
build deliberately. Neither package imports Fastify or Express.

Do not "fix" this by renaming packages to match the plan. The names differ; the
architecture does not.

---

## 2. HTTP: Fastify only

**Express is gone.** `packages/server/src/api/fastify-server.ts` is the only HTTP
edge; `app/feature-registry.ts` composes the route tree from every feature's
module and `bindRoutes` registers each
route with Fastify, using that route's guards as its `preHandler` chain. There
is no second server, no bridge, and no `express` dependency in any workspace.

This section is kept because the *reasons* still matter — they are why the
routing layer looks the way it does, and they are the measurements not to redo.

### Why Express came out

Measured, 50 concurrent keep-alive connections, load generator in its **own
process**:

```
fastify, no express bridge     53474 req/s   p50 0.82ms   p99 2.50ms
express                        15209 req/s   p50 2.80ms   p99 9.15ms
fastify + express bridge        6786 req/s   p50 5.42ms   p99 11.10ms
```

Fastify is ~3.5x Express. The **bridge** was what cost: `app.use()` ran
Express's entire middleware chain on every request, native routes included —
which is why running both at once was slower than either alone, and why the
migration had to finish rather than settle into a permanent hybrid.

After the fallback was wired correctly, and before the last routes were ported:

```
fastify native route          43984 req/s   p50 1.06ms   p99 2.25ms
fastify -> express fallback   26171 req/s   p50 1.78ms   p99 4.29ms
express standalone            15209 req/s   p50 2.80ms   p99 9.15ms
```

That is the shape that made the port incremental and safe: an un-ported route
was *still* faster than Express standalone, because Fastify's HTTP layer handled
it before handing off. Both numbers are now historical — every route is native.

### Two traps already paid for — do not re-learn these

1. **Benchmarking in-process.** An earlier run put the load generator in the
   server process and reported Fastify as *slower with a better tail*. Both
   halves were artifacts of sharing one event loop. Always measure from a
   separate process.

2. **`setNotFoundHandler` delegation without handing over the body.** Reaching
   the fallback only when Fastify has no route is the right shape, but Fastify
   parses the body first, so the downstream parser saw an empty stream and
   **every POST returned 500** while GETs kept working. A pass-through
   content-type parser does not fix it — the parsed body has to be handed over
   and marked parsed.

   The bridge this applied to no longer exists. It is recorded because the same
   failure will appear the moment anything is mounted *behind* Fastify again
   (a proxied engine route, an embedded third-party handler).

## 3. Resilience layers, and what each actually protects

| Layer | Where | Protects against |
|---|---|---|
| Circuit breaker | `packages/db/src/cores/circuit-breaker.ts` | A dead or hanging database tying up request slots. Opens after 3 consecutive *availability* failures; a hanging target went 4s → 0ms. |
| Pool error guard | `packages/db/src/cores/pool-error-guard.ts` | An idle-connection `'error'` event killing the process. This was a **real crash**, observed. |
| Target lock | `packages/server/src/platform/guards/target-lock.ts` | Two people migrating the same schema at once. |
| Rate limit | `packages/server/src/platform/guards/rate-limit.ts` | Endpoint floods. |
| Idempotency | `writeIdempotency` middleware | A retried write applying twice. |

**Important distinction the circuit breaker makes**: a syntax error or
permission denial is a *healthy* server saying no. Counting those would trip the
breaker on a user's typo and lock them out of a working database. Only
connect/timeout-class failures count — see `isAvailabilityFailure`.

**Scope, stated honestly**: the breaker, the lock and the limiter are all
per-process and in-memory. They protect one deployment from itself, which is the
case that actually happens. Coordinating two deployments against one database
needs a lock the database holds; do not imply otherwise in UI copy.

---

## 4. Logging

Pino, configured in `packages/server/src/platform/logger/logger.ts`.

- **Fastify owns the logger** (`Fastify({ logger: loggerConfig() })`), which is
  what gives every line a request id without a correlation mechanism of our own.
- `/api/health` is `logLevel: 'silent'` — the CLI launcher and the offline
  banner poll it constantly.
- Destinations: pretty in dev, JSON stdout in production, JSON file when
  `FOX_LOG_FILE` is set. The file option exists because Fox Schema also ships as
  a desktop app and a CLI where there is no platform collector. **In containers
  prefer stdout.**
- Redaction covers `password`, `option.password`, `connectionString`, `token`,
  `secret`, `apiKey`, and auth/cookie headers. Verified by test.

### The database package does not depend on Pino

`packages/db/src/cores/logger.ts` defines a **structural** `AppLogger` — no pino
import, no Fastify import. Pino satisfies it; so does a test double. The driver
runtime stays usable from the CLI, a worker, or a test with no logging stack.
Install it with `ConnectionFactory.useLogger(...)`; it is silent otherwise.

### What database logging does and does not record

Every query emits one structured line: `component`, `operation`, `engine`,
`target`, `durationMs`, `rowCount`. Slower than `SLOW_DB_QUERY_MS` (default
500ms) is `warn`, otherwise `debug`.

**Never logged**: SQL text, parameters, or rows. SQL can embed literals and rows
are the user's data. `target` is `host:port/database` — never the connection
string, which carries the password.

**Failures are logged at `debug`, not `error`** — the Fastify error boundary
logs the failure once. Logging at each layer turns one failure into four lines.

### Known limitation

`ConnectionFactory.useLogger` installs one **process-level** logger, so database
lines carry no request id. The plan's §63 recommends threading the request's
child logger down instead. That is a large refactor across many call sites and
has not been done. Database lines correlate by time, not by `reqId`.

---

## 5. Module structure — one folder per business feature

Layers, top to bottom; each imports only the ones below it
(`packages/server/src/architecture.test.ts` enforces it, and
[architecture/FEATURE-DEPENDENCY-RULES.md](architecture/FEATURE-DEPENDENCY-RULES.md)
explains it):

```
backend/
  api/            Fastify bootstrap, security headers, static assets — no routes
  app/            feature-registry.ts: FEATURES and composeFeatures, the one
                  place features are mounted; feature-module.ts: the contract
  features/       one folder per product domain, each with index.ts
    system          health, version, updates, app info, activity
    auth            sign-in, setup, password and SSO routes, sign-in settings
    users           profile, preferences, first-run wizard
    admin           users and roles, secrets, cloud credentials, policy
    workspaces      shared workspaces, members, invites, visibility
    connections     saved-connection routes, driver check/install, connection test
    files           uploads, file-query, the import engine (parsers, column
                    detection, capacity limits, worker pool, worker entrypoint),
                    the database-file picker
    compare         schema comparison
    schema          schema read
    history         schema history (Lokee), live capture, revert
    migration       DDL migration + run history
    data-migrate    data movement + run history
    sql-editor      SQL editor, code cells, sandboxed execution
    access          permissions inspector, DBA utilities, index maintenance
    git             migration repositories
    backup          backup defaults
    workflow        engine settings, proxy, grants, internal routes
  platform/       capabilities every feature uses; never imports a feature
                    identity/       auth service, sessions, auth.guard, SSO, mail
                    authorization/  RBAC, requirePermissions, admin policy
                    settings/       install-wide settings
                    connections/    saved-connection store, ref resolver
                    workspaces/     the workspace a request acts in
                    runtime/        deployment posture
                    statements/     single-statement checks
                    contracts/      ActorContext
                    guards/         origin-policy · rate-limit · idempotency
                                    target-lock · security-headers
                    http/           types · router · fastify-bind · respond · redact
                    logger/         pino config + redaction
                    db/             db-errors
                    crypto/         secret encryption
  internal/       callable in-process, deliberately not exposed as API
  database/       metadata store and migrations
```

A feature's `index.ts` exports its `ServerFeatureModule` (id, mounts with
`access` = `public` | `internal` | `user` | `registered`, and `rateLimited`)
plus whatever other features may call. Mounting is
[architecture/FEATURE-MODULE-GUIDE.md](architecture/FEATURE-MODULE-GUIDE.md).

### The layers inside a module

`route → guard → handler → controller → service`, top to bottom. A module uses
the layers it needs; it does not grow empty ones for symmetry.

`compare/` is the only module built out in all five. Its controller is currently
a **pass-through** — the service does its own permission check, so the
controller only forwards. That is recorded in the file rather than dressed up:
the layer earns its place when resource-level authorization and the scope-aware
cache attach there. If those land elsewhere, delete it.

The service layer is the valuable one and is what to copy: transport-independent,
takes an `ActorContext`, returns a value, testable with no HTTP server.

### Naming

| Suffix | Role |
|---|---|
| `*.routes.ts` | Route declarations: paths, methods, and which guards run |
| `*.guard.ts` | Middleware that admits or refuses a request |
| `*.handler.ts` | One endpoint: parse the request, call a controller |
| `*.controller.ts` | One feature: orchestrate services, own the cache seam |
| `*.service.ts` | Business logic, no HTTP types |
| `*.worker.ts` / `*-thread.ts` | Worker entrypoints — **spawned by file path** |

### Two traps this layout has already sprung

**Package exports are duplicated.** `apps/web/package.json` `exports` and the
alias list in the repo-root `vitest.config.ts` are two hand-maintained copies of
the same map. Moving a file named in one and not the other typechecks clean and
fails only in the CLI tests. Change both.

**Worker entrypoints are referenced as strings.** `files.routes.ts` spawns
`./parse-file.worker.ts` via `new URL(...)`, and
`editor/code-cell-execute.service.ts` spawns `code-cell-thread.ts` the same way.
`tsc` cannot see either path. After any move, grep `new Worker(` and `new URL('`
and check the resolved path on disk — then actually run the upload, since only a
request over 512KB takes the worker branch at all.

**Typecheck and tests are not enough.** A route that passed both hung forever in
this codebase: `idempotency` is a *factory*, was passed to `router.post` as if it
were middleware, and never called `next()`. Every extraction ends with a live
curl of the moved endpoints.

---

## 6. Index Management — a resolved bug worth understanding

Reported as "I ran defragment, refreshed, and the percentage did not change."

The maintenance **had** run. On the demo data the indexes were `relpages = 1` on
a 0-row table, so Postgres `pgstatindex` returns `NaN`, which the query converts
to null. There was nothing to reclaim and nothing to measure.

The real defect was that the UI gave no way to tell that apart from a broken
button. `describeFragmentationChange` now states the outcome: a real reduction,
an already-compact index, an unmeasurable one, or a figure that will not move
until the engine's statistics are refreshed.

**General lesson**: verifying that a statement *executed* is not the same as
verifying it had an *effect*. The defrag matrix checked execution across 11
engines and still missed this.

---

## 7. Ground rules that keep biting

- **Seed exit codes lie.** `seed-all.sh` reports "NOT seeded" for Db2 (benign
  `SQL0605W`) and sometimes CockroachDB/YugabyteDB. Verify end state directly
  before believing it — three of four such reports were false.
- **This machine cannot run all 11 engines.** CockroachDB self-terminates with
  `FATAL: disk stall`, SQL Server gets OOM-killed (exit 137). Stop the engines
  already verified before a full dialect run. Any connect-timeout failure should
  be retested in isolation before being treated as a bug.
- **Monaco virtualises.** Reading editor text from `.view-lines` silently drops
  anything below the fold.
- **Placeholders are per-driver.** `$1` Postgres, `:1` Oracle, `@pN` SQL Server,
  `$N` ClickHouse (its adapter substitutes them), `?` for the rest. Two shipped
  bugs came from assuming instead of checking the adapter.

---

## 8. Where to look

| Concern | File |
|---|---|
| Fastify edge | `packages/server/src/api/fastify-server.ts` |
| Route tree | `packages/server/src/app/feature-registry.ts` |
| Feature contract | `packages/server/src/app/feature-module.ts` |
| Layering test | `packages/server/src/architecture.test.ts` |
| Route binding | `packages/server/src/platform/http/router.ts` |
| Service pattern | `packages/server/src/features/compare/compare.service.ts` |
| Module map | section 5 of this doc |
| Logging | `packages/server/src/platform/logger/logger.ts` |
| Target locks | `packages/server/src/platform/guards/target-lock.ts` |
| Circuit breaker | `packages/db/src/cores/circuit-breaker.ts` |
| Pool guard | `packages/db/src/cores/pool-error-guard.ts` |
| Logger interface | `packages/db/src/cores/logger.ts` |

Gates: `cd apps/web && npx tsc --noEmit`, then `npx vitest run` from the root.
