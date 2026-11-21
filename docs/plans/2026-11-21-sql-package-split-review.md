# Review: splitting `@foxschema/sql` (proposal v2, 2026-11-20)

Reviewed 2026-11-21 against `main` at 0.3.22. The proposal lives outside the repo
(an Antigravity brain note, `sql_package_split_plan.md`). This page checks its claims,
lists what it misses, and proposes a smaller order that is safer to land and cheaper to
maintain.

## Claims checked

| Claim | Result |
| --- | --- |
| `packages/sql/src` has 253 source files and 94 tests | **True** (253 / 94). |
| Imports already run one way: no core folder imports a feature folder | **True.** A scan of `interfaces/`, `cores/`, `modules/{dialect,sql-text,schema-diff,migrations}` and every provider `*.sql-dialect` / `*.settings` / `*.connection` file finds **0** imports of `access`, `utilities`, `lokee-weave`, `sql-editor`, `command-mode` or `capabilities`, or of a feature concern file. |
| `@foxschema/db` reaches features only through `sql-subset` | **Mostly.** `db` imports 48 names from `@foxschema/sql`, all through the barrel, and **re-exports everything** (`export * from '@foxschema/sql'` in `packages/db/src/index.ts`). So every consumer that takes a feature symbol from `@foxschema/db` breaks in Phase 2, not just `db` itself. The plan lists this risk; the codemod has to cover `db`'s re-export too. |
| Every `npm i @foxschema/db` pulls `ibm_db` (~59 MB) | **True for `@foxschema/db`**, but that package is not published. The published app (`foxschema@0.3.1`) lists `ibm_db` under `optionalDependencies`, and the plan has the app depend on `@foxschema/db-db2` directly. So **app users download the same this release**; the saving only reaches people who install `@foxschema/db` on its own, after Phase 5. |
| Nothing is published | **True**: `@foxschema/sql`, `db`, `features`, `db-db2` and `core` are not on npm; only `foxschema` is. |

## What the plan misses

1. **The two n8n node repos build from this repo's source paths.**
   `n8n-nodes-fox-schema-sql-builder` and `n8n-nodes-db2-sql-builder` each run
   `scripts/bundle-foxschema.mjs`, which reads the sibling `../foxSchema/packages/db/src/`
   (`cores/connection-factory.ts`, `providers/adapter-registry.ts`,
   `providers/provider-registry.ts`, `index.ts`) and `packages/sql/src/index.ts`.
   - Phase 4 moves the Db2 adapter out of `packages/db`, so **the Db2 node loses its
     driver** unless its bundle script also takes `packages/db-db2` and imports it for
     registration.
   - Phase 1 shrinks `packages/sql/src/index.ts`; any feature symbol the nodes use
     (the SQL builder) has to come from `packages/features` instead.
   - Add to Phase 4 and Phase 2: update both bundle scripts in the same window, and
     build both nodes against the branch before merging.
2. **FoxAgent (`tedious-code/foxAgent`) consumes `@foxschema/sql`**, and its CI checks
   out foxSchema's default branch **unpinned**. Any symbol that moves to
   `@foxschema/features` turns FoxAgent `main` red with no FoxAgent change (this happened
   before, after `packages/core` was deleted). The repo has been quiet since 2026-09-14,
   but list what it imports before Phase 1, and pin its checkout to a tag or SHA
   first.
3. **Bundlers and the lazy `import('@foxschema/db-db2')`.** The CLI's esbuild configs
   (`apps/cli/build.mjs`, `build-binary.mjs`) list `ibm_db` as external today. They must
   list `@foxschema/db-db2` as external instead, or esbuild either fails to resolve it or
   inlines it with its native dependency. The n8n bundles need the same decision.
4. **`@foxschema/sql/internal` becomes public by accident.** A subpath "documented as
   unstable" is still importable, so it becomes an API that cannot change. For each helper
   `features` needs, either make it a real export of `sql` or move it into `features`.
   Measure how many there are in Phase 1 before choosing; don't add the subpath up front.
5. **Phase 0's re-exports at old paths need an end date.** Remove them in Phase 3, and
   have the core-boundary test fail on any import of an old path, so they don't stay
   forever.
6. **The plugin registry is global state.** Make `registerDialectPlugin` idempotent
   (registering the same dialect twice is a no-op, a different implementation throws).
   Give tests a reset, so a Db2 test cannot leak into the next file.

## Safety and maintenance verdict

The direction is sound: the boundary is already clean, so the split is a move, not a
redesign. The risk is in **who consumes the code from outside**, which the plan doesn't
cover (n8n bundles, FoxAgent), and in **churn**: Phase 1 is a ~200-file `git mv`. It
collides with every open branch that touches `packages/sql`, and right now buys only
structure, because nothing is published.

**For simple maintenance, do the cheap, real boundaries now and the big move only when
publishing is actually scheduled:**

| Order | Step | Size | Why now / why later |
| --- | --- | --- | --- |
| 1 | Phase 0: cut the seam (`sql-subset` → `query-subset`, `splitTopLevel` → `sql-text`, `isKnownEngine` → `dialect`) + core-boundary test | S | Locks today's one-way imports in a test; nothing moves between packages |
| 2 | Pin FoxAgent's foxSchema checkout; list its imports | S | Prevents a silent red `main` later |
| 3 | Phase 4: `@foxschema/db-db2` + plugin registry, **with** the n8n bundle scripts and CLI externals updated, and the Db2 n8n node built against the branch | M | Small and isolated; rehearses adding a workspace package |
| 4 | Phase 3 (guards only): one-way package rules, `db` must not import `db-db2` | S | Keeps the new boundary honest |
| later | Phases 1 + 2 (`@foxschema/features`) and Phase 5 (publish) | L + M | **Do them together** when a public release of `@foxschema/sql` is on the calendar: until then, the core-boundary test from step 1 gives the same protection with no file moves |

If you'd rather do the features split now anyway, keep the plan's order (0 → 4 → 1+2
→ 3), but land 1+2 as **one** PR in a quiet window, together with the n8n bundle updates
and the FoxAgent import list from points 1–2.
