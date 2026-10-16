# Backend extraction + Express removal — review and plan

> **All phases landed.** The backend is its own package, Express is gone, every
> error carries a code, and no route answers 500 to a malformed body. The
> per-phase notes below are kept as the record of why each step was taken. See §6 for the two layers added to the brief
> after this plan was first written: standardized error codes, and per-endpoint
> input validation.

Three asks, reviewed against the code as it stands today:

1. Move the backend out of the web app
2. Share it between CLI and web
3. Remove Express entirely

**All three are the right destination. They are not one change, and the order
matters more than the content.** (1) and (2) are the same change and are low
risk. (3) is a different kind of work with a fraction of the safety net, and
starting it before its precondition is the way this goes wrong.

---

## 1. Where we actually are

Measured, not estimated:

| Fact | Value |
|---|---|
| Backend size | **133 TS files, ~14,920 lines** (excluding tests) |
| Backend location | `apps/web/src/backend` — inside the web app |
| Backend → frontend imports | **0** — the boundary is already clean |
| Backend → `apps/web/src/shared` | **23 import sites** (permissions, server-beam, lokee-wire) |
| Frontend → same `shared/` | 13 files |
| Files importing `express` | **28** |
| Route declarations | **71**, across 15 `*.routes.ts` files |
| Routes natively on Fastify | **1** (`/api/health`) |
| HTTP-level backend tests | **1 file**, 9 tests (`fastify-server.test.ts`) |
| Backend test files total | 45 — service-level, no HTTP |
| e2e specs | 33 — **not wired into CI**, need live databases |

### The CLI already depends on the backend

This is not a future goal — it is today's arrangement, done the awkward way:

```jsonc
// apps/web/package.json
"./auth":              "./src/backend/modules/auth/auth.service.ts",
"./connection-store":  "./src/backend/modules/connections/connection-store.service.ts",
"./migration-history": "./src/backend/modules/migration/migration-history.service.ts",
"./app-settings":      "./src/backend/modules/admin/app-settings.service.ts",
"./store":             "./src/backend/database/store.ts",
"./serve":             "./src/backend/startUiServer.ts"
```

`apps/cli` imports five of these. The CLI depends on the **web application**
package to reach backend services it has nothing to do with the web UI to use.

**The cost is already being paid.** That map is hand-maintained in *two* places —
`apps/web/package.json` and the root `vitest.config.ts` — and `tsc` validates
neither. Moving a backend file while updating only one typechecks clean, passes
the unit suite, and fails only in the CLI tests. **This trap fired twice during
the module restructure**, once per PR.

Note how `@foxschema/sql` and `@foxschema/db` avoid it entirely: one export, one
alias line, `.` → `src/index.ts`. The problem is not that aliases exist. It is
that the backend exports **six deep paths into an app**.

### Someone already started this

`apps/web/tsconfig.json` and `apps/cli/tsconfig.json` both map:

```jsonc
"@foxschema/shared": ["../../packages/shared/src/index.ts"]
```

**`packages/shared` does not exist.** A dangling path mapping in two configs —
the intent was there and the package never landed.

---

## 2. Ask 1 + 2 — move the backend into its own package

**Verdict: yes.** This is the highest value-to-risk change of the three, and it
is mostly mechanical: the backend already imports nothing from the frontend.

### Target

```
packages/sql       pure dialect knowledge, zero deps          (unchanged)
packages/db        driver runtime, depends on sql             (unchanged)
packages/shared    NEW — wire contracts, zero deps
packages/server    NEW — the backend: HTTP edge + modules
apps/web           the Vite frontend, plus a thin serve entry
apps/cli           imports @foxschema/server, not @foxschema/web
```

Dependency direction, extending the existing one-way rule:

```
shared ← sql ← db ← server ← { web frontend, cli }
```

`packages/shared` is the unblocker, and it has to go first: the backend cannot
leave `apps/web` while 23 of its import sites point at `apps/web/src/shared`.
That directory is already effectively pure — a scan found exactly one import
across all three files, and it is type-only — so it becomes a zero-dep package
cleanly. The frontend keeps importing it (Vite-safe, unlike `@foxschema/db`).

### What this buys, concretely

- **The duplicated exports map collapses to one line** in each of the two
  configs. The failure mode that bit twice stops being possible to express.
- The CLI stops depending on the web app to get a database connection.
- `purity.test.ts` can be extended to enforce the new edge — frontend must not
  import `@foxschema/server` — the same way it already guards `db`.

### Naming

`@foxschema/server`. Not `core`: sibling repos (FoxFlow, the n8n nodes) already
build on a published `@foxschema/core`, and reusing the name here would collide
in the reader's head even if it never collides in a registry.

### Risk

Low, and the sweeps are known from the last two PRs: package exports live in two
files, worker entrypoints are strings `tsc` cannot see, and the CLI inlines
`@foxschema/*` TS sources through esbuild (`apps/cli/build.mjs`) — that keeps
working, since it is exactly how `sql` and `db` are already consumed.

**I found no `src-tauri` in this repo**, so this plan does not account for
desktop sidecar packaging. If the desktop build lives elsewhere and consumes
`@foxschema/web/serve`, that consumer needs checking before the rename.

---

## 3. Ask 3 — remove Express

**Verdict: yes, but not yet, and not in the same PR as the move.**

The destination is right. Express is currently carried *underneath* Fastify:
`fastify-server.ts` serves one native route and delegates everything else
through `@fastify/express`. That bridge is not free — measured at roughly an
**8x throughput drop** versus a native handler. Today the project pays for two
frameworks and gets the performance of the slower one.

So the argument for finishing is strong. The argument against *starting now* is
the safety net:

> **71 routes. One HTTP-level test file. The 33 e2e specs are not in CI and need
> live databases.**

A route rewrite is exactly the change that unit tests do not catch, because the
logic is unchanged and the transport is what moves. This codebase has already
produced the proof: a route that **passed typecheck and all 2363 tests hung
forever** in production shape, because middleware was wired wrong. Only a live
request found it.

### The precondition

**Build an HTTP contract suite before moving any route.** For each of the 71
routes, assert status code, response shape, and headers against a running
server — the Express one, first, to capture today's behavior as the baseline.
Then run that same suite against the Fastify implementation. That is the only
mechanism that makes a 71-route rewrite reviewable, and it is worth building
even if Express removal is deferred indefinitely.

### The real coupling is the guards, not the routes

The routes are the visible part; the guard layer is what actually blocks
incremental migration, because every route depends on it and it is shared.

**The codebase already shows the right pattern.** `rate-limit-core.ts` holds the
decision, `rate-limit.ts` is the thin Express adapter. `security-headers-core.ts`
is split the same way, and `origin-policy.ts` says so explicitly: *"Transport-
agnostic on purpose: it takes the origin and returns a verdict, so both servers
share one decision."*

Extend that pattern to the rest, and routes can then move one at a time:

| Guard | State |
|---|---|
| `rate-limit` | **Core already split** |
| `security-headers` | **Core already split** |
| `origin-policy` | **Already pure** |
| `idempotency` | Express-coupled — needs a core |
| `rbac.guard` | Express-coupled — needs a core |
| auth / user guard | Express-coupled — needs a core |

### What is genuinely hard, and should go last

Most of the 71 routes are JSON in, JSON out — `res.status().json()` accounts for
221 of the call sites and ports mechanically. The rest do not:

| Thing | Where | Why it is not mechanical |
|---|---|---|
| **NDJSON streaming** | `migration.routes.ts` | `setHeader` + `write` + `end` — progress events stream during a migration. Fastify streams differently; getting this subtly wrong breaks the live migration UI, not a test |
| **Cookies** | `auth.routes.ts`, `sso.routes.ts` | 4 sites; needs `@fastify/cookie`, and session cookies are a security boundary |
| **Redirects** | `sso.routes.ts` | 3 sites in the OAuth/OIDC flow — the hardest thing to test without a live provider |
| **File uploads** | `files.routes.ts` | 10 routes, plus the worker-backed import path |
| **Static + SPA fallback** | `startUiServer.ts` | `res.sendFile` → `@fastify/static` |

### Sequencing rule

**Do not start until it can be finished.** A half-migrated API ships both
frameworks and keeps the bridge tax — the worst of the three possible states.
Every phase below must leave the app shippable.

---

## 4. Plan

| Phase | Work | Gate |
|---|---|---|
| **0** | `packages/shared` — move `apps/web/src/shared`, fix the 23 import sites, delete the dangling tsconfig paths by making them real | tsc + full suite |
| **1** | `packages/server` — move the backend, single `.` export, repoint the CLI, collapse both copies of the exports map, extend `purity.test.ts` | tsc + full suite + live probe of moved endpoints |
| **2** | **HTTP contract suite** over all 71 routes against the Express server; wire it into CI | Suite green as the baseline |
| **3** | Give `idempotency`, `rbac.guard` and the auth guard transport-agnostic cores, following `rate-limit-core.ts` | Contract suite still green |
| **4** | Port routes to native Fastify, module by module, JSON-only first. Flip `FOX_SERVER` default to fastify once a module is native | Contract suite green after each module |
| **5** ✅ | Streaming, cookies, redirects, uploads and static all native | Contract suite + a manual live migration and a real SSO login |
| **6** | Delete `express`, `cors`, `@fastify/express`, `@types/express`, `@types/cors`; drop the dual-server branch in `startUiServer.ts` | Full suite + e2e run |

Phases 0 and 1 are worth doing on their own merits and are independent of
whether Express ever goes. Phase 2 is the one that is easy to skip and should
not be — it is the difference between a rewrite that is reviewable and one that
is hoped-for.

---

## 5. Open questions

1. **Does anything outside this repo import `@foxschema/web/serve`?** No
   `src-tauri` here, but the desktop shell is documented as a Node sidecar. If
   it consumes that entry, the rename is a breaking change for it.
2. **Should `packages/server` be published, or stay workspace-private?** It
   decides whether the export surface is an API contract or an internal detail —
   and therefore how carefully phase 1 has to freeze it.
3. **Is the CLI meant to keep calling backend services in-process**, or should it
   eventually talk to the HTTP API like any other client? The first keeps today's
   arrangement; the second would make `packages/server` a server and nothing
   else. This plan assumes the first, since that is what the code does now.

---

## 6. Error codes and input validation

Added to the brief after the first draft. Both were described as missing; both
turned out to be **designed and then barely adopted**, which is a better
starting position than it sounds.

### Error codes — the standard existed, the wire did not carry it

`ServiceError` with a code enum and a status table already lived in
`platform/contracts/actor.ts`. Two problems, both measured:

- **Used at 1 of 144 error sites.** The other 143 are hand-rolled
  `res.status(400).json({ error: '...' })`.
- **The code never left the server.** Even the one adopting handler sent
  `{ error: message }`. A client could see a 400 but not tell a malformed body
  from a rejected value, and could not tell a lock conflict from any other 409.

The response envelope was inconsistent too: some routes send `{ error }`, others
`{ ok: false, error }`.

**Done (phase 0):** the vocabulary moved to `@foxschema/shared` — the frontend
is the party that switches on it, and a contract only one side can read is not a
contract. Codes were grounded in the statuses the API already returns rather
than invented, and the envelope now always carries `ok`, `error` and `code`,
with optional `fields` and `retryAfterSec`.

**Remaining:** adopt it at the other 143 sites. That is one module at a time,
and it is the same edit as the Express port — so **do them together**, per
module, rather than touching every route twice.

### Input validation — one module has it, fourteen do not

`compare/compare.schema.ts` is the existing pattern, and its header records why
it exists: `POST /compare {}` used to reach the service and surface as
`500 Cannot read properties of undefined`. A caller's malformed request,
reported as a server fault.

**No other module has a schema file.** Validation elsewhere is ad-hoc inside
handlers, or absent.

**Approach — hand-written parsers, not a schema library.** Fastify can compile
JSON Schema natively, which is the tempting answer given where this is heading.
Rejecting it for now, for the same reason `csv-stream.ts` and `ndjson-stream.ts`
were hand-written: this repo treats a dependency as supply-chain surface that CI
scans on every build, and the existing parser is 50 readable lines that produce
better messages than a generic validator would. Revisit only if the count of
schema files makes the repetition real.

Each `parse*Input` returns the typed input or throws
`ServiceError('invalid_input', …)`, and now populates `fields` so a form can
mark the offending input instead of showing a banner.

**Where it runs:** in the handler, before the controller. Not in the route — a
route is transport wiring, and validation that lives in Express middleware is
validation a second transport can skip. That is the same failure mode the
`ActorContext` design exists to prevent.

### Revised phase order

Phases 2–4 change, because error-code adoption and validation are per-module
edits that touch the same lines the Express port does:

| Phase | Work |
|---|---|
| **0** ✅ | `packages/shared` + the error contract on the wire |
| **1** ✅ | `packages/server` — backend moved, exports map collapsed to one entry |
| **2** ✅ | HTTP contract suite over all 80 routes, in CI |
| **3** ✅ | Guards run unchanged on Fastify — the shared `HttpRequest`/`HttpResponse` subset made per-guard cores unnecessary |
| **4** ✅ | Error codes at all 123 sites; the 6 unvalidated routes fixed |
| **5** ✅ | Streaming, cookies, redirects, uploads and static all native |
| **6** ✅ | `express`, `cors`, `@fastify/express` and both `@types` removed |

Phase 4 doing all three edits per module is the point: visiting 15 modules once
costs far less than visiting them three times, and the contract suite from
phase 2 covers all three kinds of change at once.

---

## 7. Found along the way — fixed separately

**The production frontend build was broken on `main`, and CI did not catch it.** Fixed
in its own commit; a `Frontend build` job now guards it.

`npm run build -w @foxschema/web` — the command the CLI tells users to run —
fails to resolve `monaco-editor/esm/vs/editor/editor.api`. The cause is not the
pin: `monaco-editor@0.56.0` and the deep-import style landed in the same June
commit. `monaco-editor@0.56.0` ships `exports: { "./*": "./esm/vs/*.js" }`, and
Vite 8's rolldown resolver enforces `exports` where the previous bundler did
not, so every `monaco-editor/esm/vs/...` specifier now resolves to
`esm/vs/esm/vs/...`.

Rewriting the 21 specifiers is **not** the fix: 0.56 also removed the
per-language files, and `esm/vs/basic-languages/` now contains only
`monaco.contribution.js`. Restoring the SQL editor's language registration
under 0.56 needs its own change and real browser verification.

`.github/workflows/build-gate.yml` runs typecheck, vitest and eslint — **never
`vite build`**, which is why this has gone unnoticed. Adding the build to CI is
worth doing regardless of when Monaco gets fixed.

---

## 8. How Express actually came out

Not by rewriting 80 handlers. The HTTP contract suite proves statuses and error
bodies; success-path payloads need live database state, so a hand-rewrite would
have changed code nothing verifies. Instead the layer *underneath* the handlers
was replaced:

| File | Job |
|---|---|
| `platform/http/types.ts` | The request/response subset the handlers use — a subset on purpose, so adding to it is a decision |
| `platform/http/router.ts` | Collects route declarations. Matches no URLs, runs no chain |
| `platform/http/fastify-bind.ts` | One `fastify.route()` per declaration, guards as that route's `preHandler` |

Handler bodies are byte-identical. The framework under them is completely
different, and every route is its own registration — which is the performance
argument made good: a limiter on an upload path now costs nothing on
`/api/health`.

**Two bugs only running it could find**, both after a green typecheck and 2448
passing tests:

- Fastify allows one not-found handler per instance; `createFastifyApp` and
  `startUiServer` each set one, so the process threw on boot. The 404 now has a
  single owner and `startUiServer.test.ts` covers assembly.
- `startUiServer` returned the *requested* port, so `port: 0` — "any free
  port" — came back as 0, useless to the caller.

**What was deliberately not standardised:** the revert flow answers with
`schema_drifted`, `blocked` and `confirm_lossy`, declared in `lokee-wire.ts` and
switched on by `VersionCompareModal`. Replacing those with a generic `conflict`
would have broken a working feature to satisfy a pattern. Endpoints returning
`success` keep it too.

## 9. e2e status

Run against the Express-free server, with the app driven in a real browser:

| Suite | Result |
|---|---|
| smoke, schema-history, schema-browse, auto-error | pass |
| SQL editor (9 files) | pass |
| postgres, mysql, mariadb, sqlite, duckdb, clickhouse | pass |
| sqlserver, oracle, db2, tidb, redshift, azuresql, yugabytedb | pass |
| **cockroachdb** | **container is down** — exited with `disk slowness detected`, a known limit of this machine, not a code failure |
| **sql-editor-peek-row-form** (2 tests) | **pre-existing failure** — fails identically on the commit before the port, confirmed by A/B |

`sqlite` and `duckdb` failed until reseeded: macOS had cleaned
`/tmp/foxschema-sqlite` and `/tmp/foxschema-duckdb`. Reseed those before an e2e
run, or file-based dialects fail for reasons that have nothing to do with the code.
