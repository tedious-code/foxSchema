# API restructure — plan, decisions, and open questions

Status: **partly implemented — historical reasoning, not a map.** The layout is
in place; the layering is not. Last reconciled against the tree 2026-09-21.

| Step | State |
|---|---|
| Split `api/routes.ts` by feature | **Done** — 1572 → 486 lines, `api/` 31 → 16 files |
| One folder per business feature | **Done** — every file lives in a module; `modules/` has no loose files |
| Cross-cutting code out of `api/` | **Done** — `platform/` holds guards, logger, contracts, db helpers |
| CORS origin allowlist | **Done** — closed a real hole (any localhost origin was trusted) |
| 5 layers per module | **`compare` only.** The other modules have routes + services |
| CSRF header guard | Not started — now viable, since the origin hole is closed |
| Resource-level authorization (§6) | Not started — highest remaining security value |
| Async stores for locks / idempotency / rate limit | Not started — multi-instance prep |
| Scope-aware cache (§4) | Not started, deliberately last |
| Remove Express entirely | **Done** — see `docs/plans/backend-extraction.md` §8 |

**Paths below are as-written and now stale.** The tree has moved twice since:
out of `apps/web/src/backend/` into `packages/server/src/`, and through a
`modules/` naming that has since gone back to `features/`. Today
`features/compare/service.ts` is
`packages/server/src/features/compare/compare.service.ts`. The current layout is
`docs/CODE_MAP.md`, and section 5 of `docs/BACKEND_ARCHITECTURE.md`. The
reasoning below is kept unedited — it is the record of why, not a map of where.

Open question 4 is still unanswered and blocks the cache design: **can two
users of one deployment see different connection sets?** That decides whether
the cache key needs an actor in it.

Written to be argued with. Several parts of the brief are challenged below,
with reasons — accepting them unchallenged would cost more than it buys.

---

## 1. Where we actually are

Measured, not estimated:

| Folder | Files | Lines | Note |
|---|---|---|---|
| `api/` | 31 | 6067 | `routes.ts` alone is 1572 |
| `modules/` | 28 | 6920 | `lokee-weave.module.ts` alone is 1575 |
| `features/` | 3 | 258 | **The pattern we want, already here, barely used** |
| `database/` | 9 | 881 | metadata store |

The problem is not "too many files". It is that files are grouped **by kind**
(`api/`, `modules/`) rather than **by feature**, so one change touches three
folders, and two files hold 3147 lines between them.

**What already exists and must not be rebuilt:**

- RBAC: `rbac.middleware.ts`, `requirePermissions`, `denyUnless`,
  `shared/permissions` with a typed `Permission` union.
- Authentication: cookie sessions (`sameSite: 'lax'`, `secure` in production),
  a local single-user bypass, and SSO routes.
- Rate limiting, idempotency, target locks, circuit breaker, Pino logging.

So this is a **reorganisation with gaps filled**, not a greenfield rewrite. That
distinction should drive every step below.

---

## 2. The layer stack — I am proposing four, not five

The brief asks for:

```
route -> guard -> controller -> services -> handlers
```

**Controller and handler are the same layer.** Every convention that uses both
ends up with one of them as a pass-through that only forwards arguments. That
is precisely the "too many functions and duplication" the brief wants to avoid,
so I would drop one name and keep four layers:

```
modules/<feature>/
  <feature>.routes.ts     path + method + schema + which guards
  <feature>.guards.ts     only if the feature needs guards of its own
  <feature>.handler.ts    HTTP in / HTTP out. No business logic.
  <feature>.service.ts    the actual work. No req, no reply, no HTTP status.
  <feature>.types.ts      shared shapes
```

The rule that makes this worth doing, and the only one worth enforcing:

> **A service must be callable from a CLI, a worker or a test with no HTTP
> server.** If it imports `FastifyRequest`, it is a handler, not a service.

`features/compare/service.ts` already passes that test. It is the template.

### File count, honestly

Four files × ~10 features ≈ 40 files, replacing 59 in `api/` + `modules/`. Fewer
files, and — more importantly — a change to compare touches one folder.

Do **not** create four files per *route*. That is 38 routes × 4 = 152 files and
would make the complaint worse. One set per **feature**.

---

## 3. Feature modules

Exposed over HTTP:

| Module | Absorbs |
|---|---|
| `auth` | login, session, SSO, OIDC |
| `connections` | CRUD, test, resolve |
| `schema` | browse, tables, objects, DDL |
| `compare` | comparison + diff |
| `migration` | plan, execute, history |
| `history` | Lokee versions, revert, snapshots |
| `editor` | SQL execute, code cells, paging, grid CRUD |
| `access` | permission builder / inspector / report |
| `files` | upload, file query |
| `admin` | users, roles, app secrets |

Platform modules — cross-cutting, imported by features, no routes of their own:

`authn`, `authz`, `cache`, `logger`, `rate-limit`, `idempotency`,
`target-lock`, `errors`.

### Internal modules the API must not expose

The brief asks for this and it is a good instinct. Discipline alone will not
hold it. Enforce it structurally:

```
modules/internal/**   may not be imported by any *.routes.ts
```

An ESLint `no-restricted-imports` rule, checked in CI. `driver-install`,
`updates`, `cloud-secrets` and the metadata store belong there.

---

## 4. Caching — where the brief is dangerous

The brief says: *"a module handle cache as global embed in controller, use cache
on handler layers."*

Three problems, in order of severity.

### 4.1 A global cache keyed on the wrong thing is a data leak

Schema metadata for connection X, cached globally, must never be served to a
user who cannot access X. **Every cache key must include the authorization
scope**, not just the connection id:

```ts
key = `${userId}:${connectionId}:${schema}:${kind}`
```

Caching before the authorization check is a vulnerability, not an optimisation.
This is the single most important line in this document.

### 4.2 Cache at the service layer, not the handler layer

Handler-layer caching stores the HTTP response shape, so a CLI or worker calling
the same service gets nothing, and two endpoints returning the same domain
object cache it twice. Service-layer caching is reusable and deduplicated.

### 4.3 Schema metadata goes stale the moment a migration runs

A TTL alone is wrong: it means a user who just ran DDL sees the old schema until
it expires. Cache invalidation must be **event-driven**:

- `migration.execute` completing invalidates that target's schema entries.
- Editor DDL (`CREATE`/`ALTER`/`DROP`) invalidates the same.
- TTL is the backstop for changes made outside Fox Schema, not the primary
  mechanism.

A bounded LRU with an explicit `invalidate(prefix)` — the size cap matters for
the same reason the rate limiter needed one.

---

## 5. Authentication — questions before code

The brief lists *"simple login, api header, JWT, SSO, OIDC"*. Cookie sessions,
SSO and RBAC already work. Before adding JWT, three questions:

1. **Will you run more than one API instance?**
   JWT's real advantage is statelessness for horizontal scale. Its real cost is
   that you cannot revoke a token before it expires. On a single instance,
   opaque session tokens are *better*: revocation is instant. Adding JWT to a
   single-instance deployment is a downgrade wearing a badge.

2. **Who are the API keys for — humans or CI?**
   If CI and scripts, that is a different credential with different lifetime,
   scope and revocation than a user session. It should be its own concept
   (`api_key` with scoped permissions), not a JWT variant.

3. **Is OIDC needed beyond the SSO you already have?**
   OIDC is one specific SSO protocol. If the existing SSO covers the identity
   providers your customers use, OIDC is a second implementation of a solved
   problem.

**Recommendation**: one `authn` module with pluggable credential sources —
session cookie, API key, bearer — resolving all of them to the same
`ActorContext` that `features/actor.ts` already defines. Add JWT only if
question 1 is answered "yes".

---

## 6. Authorization — two checkpoints, not one

The brief asks for authorization "on middleware to check permission … and
before execute query". That is correct, and they are genuinely different checks:

- **Route guard**: may this actor call this endpoint? Coarse, cheap,
  `requirePermissions('schema.migrate')`. Exists today.
- **Resource check**: may this actor use *this connection*, *this schema*?
  Fine-grained, needs the request body. This is the one that matters, because
  the route guard cannot see which connection was named.

The second check must happen **before the query runs and before any cache
read** — see §4.1.

`shared/permissions` already models the verbs. What is missing is the
resource-level check, and that is where the effort should go.

---

## 7. Transport security — where the brief points at the wrong layer

### HTTPS

Fox Schema ships as a desktop app, a CLI and a container.

- **Desktop / CLI**: binds `127.0.0.1`. TLS there means self-signed certs,
  browser warnings and a cert lifecycle, protecting a loopback interface. Not
  worth it.
- **Container / cloud**: TLS terminates at the ingress. Doing it in-process
  duplicates that badly.

What is actually needed, and cheap:

- HSTS when serving over a public origin (already in the security headers).
- `secure` cookies in production (already done).
- **Refuse to start with authentication enabled on a non-loopback bind over
  plain HTTP**, unless explicitly overridden. That closes the real hole — a
  Docker deploy on `0.0.0.0:3210` with no proxy in front.

### CSRF — a genuine gap

Cookie sessions plus `sameSite: 'lax'` blocks classic cross-site form POSTs but
is not complete protection. Options:

| Approach | Cost | Verdict |
|---|---|---|
| Double-submit token | Token endpoint, client changes, per-request plumbing | Works, most moving parts |
| **Required custom header** | One guard, one client header | **Recommended** |
| Drop cookies for bearer | Larger client change, must store the token somewhere | Right long-term if API keys land |

The custom-header approach works because a cross-site request cannot set a
custom header without a CORS preflight the server will refuse. The SPA already
sends `credentials: 'include'` from its own origin, so it is one header.

Applies to state-changing methods only — POST, PUT, PATCH, DELETE.

### CORS

Already configured. What to verify during this work: that the allowlist is not
`*` when credentials are enabled, since that combination is rejected by browsers
and usually indicates a misconfiguration nobody noticed.

---

## 8. Sequencing — each step shippable and reversible

The e2e suite cannot run reliably on a machine that cannot hold 11 engines, so
each step must be verifiable **without** it.

**Step 1 — the seam, no behaviour change.**
Create `modules/<feature>/` for one feature (`compare`, since its service
already exists and has tests). Move files, keep the Express route delegating to
it. Nothing else changes. Proves the shape.

**Step 2 — platform modules.**
`cache`, `authn`, `authz`, `errors` as real modules with tests. No feature uses
them yet. Pure addition, cannot regress anything.

**Step 3 — resource-level authorization.**
The §6 gap. Highest security value in the plan, independent of the
restructuring.

**Step 4 — CSRF guard.**
One guard, one client header, applied to state-changing methods.

**Step 5 — feature-by-feature migration.**
In risk order, read-only first: `schema` → `compare` → `history` → `access` →
`editor` → `migration` → `auth`/`admin` last. Each becomes a native Fastify
route as it moves, so the Express fallback shrinks with each step.

**Step 6 — delete Express.**
When the fallback stops being reached. Measurable: log every delegation, ship
when the count is zero.

**Step 7 — caching.**
Deliberately last. Caching an unstable structure caches the wrong thing, and
caching before §3's authorization is in place is a leak.

---

## 9. What I would not do

- **Do not add JWT** until §5 question 1 is answered yes.
- **Do not add app-level HTTPS.** Fix the bind-address check instead.
- **Do not create controller *and* handler layers.**
- **Do not cache before resource-level authorization exists.**
- **Do not restructure `lokee-weave.module.ts` (1575 lines) in the same step as
  moving it.** Move first, split second — a move with a rewrite inside it cannot
  be reviewed.

---

## 10. Open questions

1. Horizontal scale — one API instance or several? Decides JWT.
2. API keys — for CI/scripts, or human convenience? Decides whether they are a
   separate credential type.
3. Is the existing SSO insufficient for a customer, or is OIDC aspirational?
4. Multi-tenant — can two users of one deployment see different sets of
   connections? Decides how hard the §4.1 cache key has to work.
5. Is there an appetite for an ESLint boundary rule in CI, or should the
   internal-module rule be convention only?
