# Schema versioning, revert, and history graph

Status: proposal. Nothing implemented yet.

This merges two drafts: `foxschema-database-versioning-implementation.md`
(the versioning core) and an earlier draft focused on revert. Where they
disagreed, the versioning spec generally wins — its model is stronger. What
follows notes both what was adopted and what it was missing.

## Adopted from the versioning spec

These are better than the earlier draft and should be taken as written:

- **Database identity** (`dialect + host + port + database + schema`, hashed,
  credentials excluded). The earlier draft keyed history off the saved
  connection, which is wrong: two saved connections pointing at the same
  database would each grow a separate history, and rotating a password would
  orphan it. Keep the `instanceFingerprint?` escape hatch for later.
- **Capture is decoupled from migrate.** A version is created only when the
  schema hash changes; repeat captures record an *observation* instead. The
  earlier draft tied snapshots to migration runs, which cannot represent
  changes made outside FoxSchema — the case most worth catching.
- **Order-independent schema hash** from `(objectKey, objectHash)` pairs sorted
  by key. The earlier draft did not specify this, and introspection order is
  not stable across dialects or driver versions.
- **Object granularity below the table** — columns, indexes, constraints as
  first-class content-addressed objects. This is what makes the roadmap say
  "email varchar(100) → varchar(255)" instead of "customer changed".
- **Full schema always, regardless of comparison scope** (Rule 2). The earlier
  draft left this open; this resolves it in the safer direction.
- **Reuse the existing compare engine** for version-to-version diff (Rule 8).

## What the versioning spec is missing

### 1. Revert — the original requirement — is out of scope

§19 explicitly excludes rollback. That is a defensible Phase 1 boundary, but
it means the headline ask ("users can revert database schema") is not
delivered by that plan, and the design work it needs has not been done:

A schema version records *structure*, not data. Reverse DDL can be generated,
but reversibility is per-operation:

| Forward | Reverse | Class | What is lost |
|---|---|---|---|
| ADD COLUMN | DROP COLUMN | reversible | data in the new column |
| CREATE INDEX / VIEW / PROC | DROP it | reversible | nothing |
| CREATE TABLE | DROP TABLE | reversible | rows inserted since |
| WIDEN type (varchar 50→200) | narrow back | **lossy** | values longer than 50 |
| DROP COLUMN | ADD COLUMN | **lossy** | every value, permanently |
| DROP TABLE | CREATE TABLE | **lossy** | every row, permanently |

So the feature is **"revert schema"**, never "undo", and the confirm dialog
must name the columns and tables whose data cannot come back — the same
discipline as the existing Safe-mode write confirm, which lists the affected
statements rather than asking for blanket approval.

Revert also needs a **drift check**: compare the live schema against the
version being reverted *from*. If they differ, someone changed the database in
between and a blind revert would clobber their work. The versioning model
gives this for free — capture, compare hashes — which is another argument for
building versioning first.

A revert should be recorded as its own migration run (`reverts_run_id`), so
history stays a complete account and reverting a revert is just another run.

### 2. "Who migrated" is deferred too far

The original ask included *who* and *when*. §7's `source: 'deploy'` records
the kind of event but not the actor; the actor only appears in §18's
`schema_deployment`, which is deferred.

This is cheap to fix now: `migration_runs` already stores `user_id`,
`started_at`, `status` and per-object results. Give `schema_version` a nullable
`migration_run_id` in Phase 1 and the attribution comes along for free — the
join already has both sides.

### 3. The existing snapshot path is left undefined

FoxSchema already takes a pre-migration snapshot and stores it in
`migration_runs.snapshot_ddl`. The versioning spec builds a parallel system and
never says what happens to it. It has three defects that make it unusable as a
versioning source:

1. **Tables only** — `routes.ts` calls `provider.getTables()` and nothing else,
   while comparison scope covers views, functions, procedures, triggers,
   sequences, MQTs.
2. **Truncated at 1 MB** — `cap()` in `migration-history.module.ts` appends
   `-- … (truncated)`.
3. **Silently skipped** when a provider has no `getTables`.

Building versioning fresh sidesteps all three, which is the right call.
Decide explicitly: keep `snapshot_ddl` as a human-readable download and mark it
as such, or retire it once versions can render equivalent DDL. Do not leave two
half-truths in the UI.

### 4. Retention is unaddressed

Versions, observations and `schema_object` rows grow monotonically. An hourly
scan across 20 databases produces ~175k observation rows a year. Decide the
pruning policy early even if built last, because it constrains whether
`schema_object` can be shared across identities (sharing dedups far more —
dev/staging/prod are near-identical — but complicates deletion).

### 5. Repo constraints the spec does not reflect

- **The metadata DB is append-only.** New tables go in a *new* migration id in
  `apps/web/src/backend/database/schema.ts`. Never edit a shipped migration.
- **The metadata DB runs on four engines** (SQLite/Postgres/MySQL/SQL Server)
  via the `types(d)` helper. The spec's `interface` sketches need mapping to
  `t.id / t.str / t.int / t.ts / t.big`; `canonicalDefinition` is `t.big`.
- **RBAC exists.** Capture is harmless; revert is more dangerous than migrate
  and deserves its own permission.

## The biggest risk: canonicalisation, per dialect

`same schema → same hash` carries the entire design. If canonicalisation is
imperfect for one dialect, every scan mints a spurious version and the history
becomes noise.

This is not hypothetical here. `DIALECTS.md` already documents per-dialect
normalisation that exists precisely because raw introspection output differs
for identical schemas — view-header stripping, Db2 system-name normalisation,
Oracle case folding. **Hashing inherits every one of those quirks.**

So the invariant needs stronger tests than §24 implies:

1. **Live, per dialect.** Capture twice against an unchanged database on each
   of the six Docker dialects → identical hash. A unit test over hand-written
   fixtures cannot catch Oracle folding an identifier or Db2 substituting a
   system name. The `apps/e2e` harness already stands these up.
2. **Tied to the existing engine.** *Compare reports equal ⟺ hashes equal.*
   This is the invariant that keeps versioning honest about what a "change"
   means, and it is testable against the seeded `demo_a` / `demo_b` pairs.
3. **Round-trip.** Capture → generate DDL → apply to an empty database →
   capture again → same hash.

If (2) fails, either compare has a false diff or canonicalisation is too
aggressive. Both are bugs worth finding.

## Reuse anchors that already exist

- `stableStringify` — `apps/web/src/frontend/lib/resultValueKey.ts:65`. §9 asks
  for exactly this. It is currently private and frontend-only; promote it into
  `@foxschema/sql` so backend versioning and the frontend share one
  implementation rather than drifting apart.
- `normalizeTableSchemas` — `packages/sql/src/cores/schema-to-tables.ts:143`.
  The existing normalisation entry point, and the natural seam for
  `SchemaCanonicalizer`. Satisfies Rule 8 and §16's "one canonical model".
- `CompareModule` — feeds §15's version diff without a second diff engine.
- `packages/sql` is pure and dependency-free by design, and `purity.test.ts`
  enforces it. Canonicalisation and hashing belong there; persistence does not.

## Scale note

Column-level granularity multiplies manifest rows by roughly 10–30×. A 200-table
schema at 20 columns each is ~4–6k `schema_version_object` rows *per version*.
That is fine at that size and still far cheaper than full copies, but it is
worth measuring at 10k objects before assuming the design holds — the spec
does not address it.

## Ordering

Take §24's order, with three amendments:

1. …after "stable database identity", add **`migration_run_id` on
   `schema_version`** so attribution lands in Phase 1 rather than §18.
2. …after "prevent duplicate versions", add the **live per-dialect invariant
   tests** above. This is the gate; nothing downstream is trustworthy without
   it.
3. …after "object roadmap", insert **revert** — reversibility classification,
   drift check, confirm dialog, RBAC gate — before migration/deployment
   linkage.

## Open questions

- **`schema_object` global or per identity?** Global dedups far better;
  complicates retention and multi-tenant isolation.
- **SQLite identity.** §2 says "database file identity". A resolved path is the
  practical answer, but a copied or replaced file silently inherits history —
  the same class of problem as §22's host-repointing note.
- **What happens to `snapshot_ddl`?** Keep as a download, or retire.
- **Who may revert?**
