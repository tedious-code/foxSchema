# Extended seed test-case matrix — 2026-07-01

Extends `docker/init/{postgres,mysql,mariadb,sqlserver,oracle}/01_seed.sql`
(`02_seed.sql` for Oracle) with one object set per migration-generator path
that the original demo data did not cover. All five files were validated to
load cleanly via `bash scripts/seed/seed-all.sh all` against live containers.

**How to run:** `docker compose up -d`, then `bash scripts/seed/seed-all.sh all`
(required even if volumes persisted — init scripts only auto-run on empty
volumes), then `npm run dev`, then `cd apps/e2e && node scripts/run-all.mjs`.
Reseed before every run — see the clean-run rule in
[2026-07-01-migration-ordering-bugs.md](2026-07-01-migration-ordering-bugs.md).

## Case matrix (identical on all 5 dialects unless noted)

| # | Objects | Diff produced | Generator path exercised |
|---|---------|---------------|--------------------------|
| 1 | `demo_a.coupons`, `demo_a.order_coupons` | 2 ADDED tables; `order_coupons` has a **composite PK** and FKs to `coupons` (ADDED) and `orders` (MODIFIED) | `sortAddedByDependency` (coupons must be created first), table-level PK constraint rendering, FK to an already-existing table |
| 2 | `demo_a.fn_tier_priority` + `trg_customer_tier` on `customers` | ADDED function + ADDED trigger riding a MODIFIED table's ALTER step; the trigger **calls the new function** and references the `tier` column added by the same ALTER | Live regression for the routine-before-ALTER ordering fix (PR #15) on every dialect, not just Postgres |
| 3 | `v_active_products` in both schemas | MODIFIED view — demo_a appends a `sku` column and an `active` filter | `alterViewStatement` (SQL Server) / `CREATE OR REPLACE VIEW` (others). Append-only column change because Postgres `OR REPLACE` forbids reordering existing view columns |
| 4 | `trg_item_price_check` on `order_items` in both schemas | MODIFIED trigger (demo_b has a weaker body; on PG the *definition* differs — `INSERT OR UPDATE` vs `INSERT`) | `dropTriggerStatement` + recreate-from-source inside the table's ALTER step |
| 5 | `fn_get_discount` body changed in demo_b | MODIFIED function (was byte-identical/UNCHANGED before) | Routine ALTER path: `dropRoutineSql` + recreate. **Predicted failure on MySQL/MariaDB/SQL Server** — see below |
| 6 | `idx_b_orders_created` in demo_b only | REMOVED index on a MODIFIED table | `dropIndexStatement` in destructive mode; skip-path in non-destructive mode |
| 7 | `trg_b_orders_touch` on `orders` in demo_b only — **not on Postgres** | REMOVED trigger | `dropTriggerStatement` for a target-only trigger; non-destructive skip-path |
| 8 | `demo_b.order_items.unit_price` made nullable | Nullability-only column change (no type change) | `modifyColumnStatements` nullability restatement |
| 9 | `demo_b.order_items.qty` DEFAULT 0 (A: DEFAULT 1) | Default-only column change | `setDefaultStatements` |

## Predicted outcomes (write down before running — failures are only
## meaningful against a prediction)

- **Case 5 will likely fail on MySQL, MariaDB, and SQL Server** and is
  included deliberately. `alterObjectStatements` for a MODIFIED
  FUNCTION/PROCEDURE calls `dropRoutineSql` directly — it never consults the
  dialect's `dropFunctionStatement` hook (unlike `dropObjectStatements`,
  which does). `dropRoutineSql` emits a signature-qualified
  `DROP FUNCTION IF EXISTS name(sig);` whenever the provider supplies
  parameters — and the MySQL, Postgres, and SQL Server providers all do.
  Postgres accepts a parenthesized signature; **MySQL/MariaDB and SQL Server
  do not** (syntax error). Expected fix (separate PR): route the ALTER-path
  routine drop through the same dialect hooks as the DROP phase.
- **Case 2 should pass everywhere** — it's the fix from PR #15. If it fails
  on a non-Postgres dialect, that dialect creates triggers somewhere other
  than the table's ALTER step and needs its own look.
- **Case 3 depends on alphabetical MODIFIED ordering.** MODIFIED steps run in
  compare-output order (alphabetical). `v_active_products` sorts after
  `products`, so the view's new definition (which references `products.sku`,
  added by the products ALTER) happens to run after that ALTER. A view named
  e.g. `a_view` would break — MODIFIED-vs-MODIFIED dependency ordering is a
  known design gap, documented here so the eventual failure isn't a surprise.
- **Case 7 is deliberately excluded on Postgres.** A PG trigger needs a
  backing function; removing both means the DROP phase would
  `DROP FUNCTION` while the trigger (dropped later, inside the table's ALTER
  step) still depends on it → `cannot drop function … trigger depends on it`.
  That cross-phase drop-ordering gap (REMOVED routines vs table-attached
  REMOVED triggers) is real but would abort the whole PG transaction at step
  1 and mask every other case; deferred with the other PG items below.
  Same reason case 4 on PG keeps `_trg_item_check` **byte-identical** in both
  schemas: a MODIFIED backing function would be dropped mid-plan while the
  trigger still references it.
- **Pre-existing failures unaffected by this data**: PG `default for column
  "status" cannot be cast automatically to type order_status` (enum
  default-cast, deferred in the ordering-bugs doc) still fails the PG run;
  SQL Server `ALTER SEQUENCE … AS` still fails the SQL Server run; Oracle
  `ORA-02289` still under investigation. Expect those dialects to stay red
  until fixed — check that the *new* cases' statements appear in the
  generated Migration SQL and that failures match the predictions above.

## Predictions vs. actual (confirmed same day, 2026-07-01)

- **Case 5 confirmed exactly as predicted** on MySQL/MariaDB/SQL Server —
  `error near '(decimal(10,2), int)'` / `Incorrect syntax near 'decimal'`.
  Fixed same session — see the "MODIFIED-routine drop fix" section in
  `2026-07-01-migration-ordering-bugs.md`. MariaDB now passes the full E2E
  flow end-to-end.
- **Case 2 confirmed passing everywhere** the fix reached (Postgres, MySQL,
  MariaDB, SQL Server) — routines create before ALTER on every dialect, not
  just Postgres.
- Fixing case 5 let MySQL/SQL Server progress further and land on their own
  separate, unrelated pre-existing issues (SQL Server `ALTER SEQUENCE`, MySQL
  `SYSTEM_USER` privilege gap) — expected, not a regression.
- **DB2 added to the matrix's dialect coverage after this doc was written**
  (`docker/init/db2/01_seed.sql`, wired into E2E the same session — see the
  other plan doc). Note: DB2's seed does **not** yet include the case-2
  (function-called-by-new-trigger) or case-5 (MODIFIED function) equivalents
  — it currently only exercises tables/views/indexes, not functions/
  procedures/triggers. DB2's migration fails earlier anyway (a new
  `SQL0601N` index-name collision on the very first CREATE TABLE), so cases
  2/5 wouldn't be reached yet regardless — worth adding once that's fixed.

## Files touched
- `docker/init/postgres/01_seed.sql`
- `docker/init/mysql/01_seed.sql`
- `docker/init/mariadb/01_seed.sql`
- `docker/init/sqlserver/01_seed.sql` (also gained an unrelated trigger-drop
  ordering fix the same session — see the other plan doc)
- `docker/init/oracle/02_seed.sql`
- `docker/init/db2/01_seed.sql`, `docker/init/db2/01_seed.sh` (new — DB2 had
  no seed infrastructure at all before this session)

`scripts/seed/*.sql` (the non-docker copies) were intentionally left alone —
they have uncommitted local modifications from a parallel effort.
