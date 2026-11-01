# Safe column change: plan and SQL for review

Board card: `safe-column-change`, new feature id `utilities.columns`. Decided
on 2026-11-01: v1 shows what a change touches and generates the SQL to
review, copy or open in the editor. Fox runs nothing itself in v1.

## Why

An in-place `ALTER COLUMN … TYPE` or `RENAME COLUMN` on a big or busy table
can lock it, rewrite it, fail halfway on a value that does not convert, or
break whatever depends on the old name. The safe way is longer: add a new
column, copy the data in batches, check it, switch over, then drop the old
column only once nothing needs it. People skip steps because writing that SQL
per engine is tedious. Fox can write it, and first show what it touches.

## What the user does

**Utilities → Change column.** The flow follows Clone Table (`CloneTableModal`):

1. Pick a connection, a table, a column.
2. Pick the change: **rename**, **change type**, or both. Type options come
   from the dialect's type list (`packages/sql` type mapping).
3. Fox shows **what it touches**, from the schema it already reads
   (`TableSchema`: `columns`, `indices`, `foreignKeys`, `primaryKey`,
   `triggers`, plus the other tables and views of the schema):
   - **Foreign keys:** outbound (this column references another table) and
     inbound (other tables' `foreignKeys` that point at this column).
   - **Indexes and constraints:** the primary key and every index that
     includes the column.
   - **Triggers** on the table.
   - **Views** whose definition mentions the column. Labelled "may use",
     since this is a text match, not a parse.
   - **The conversion:** whether the type change can lose data (narrowing,
     text to number, time zone), from the dialect's cast rules.
   - A blocker list (for example, a primary key column on SQLite) that stops
     generation, with the reason.
4. Fox generates the SQL as **numbered steps**, each with a heading saying what
   it does and whether it is safe to rerun:
   1. Add the new column, nullable, no default (instant on most engines).
   2. Copy in batches: an `UPDATE … WHERE new IS NULL AND key BETWEEN …` loop
      per dialect, keyed on the primary key, with a batch size field (default
      10,000). Resumable: it rerun-safely skips copied rows.
   3. Check: count rows where old and new disagree after conversion; expect 0.
   4. Keep them in step until switch-over: a trigger copying writes to the
      new column, on engines that support it, or a note to pause writes.
   5. Recreate indexes and foreign keys on the new column.
   6. Switch over: rename old to `<col>_old`, rename new to `<col>`. Atomic
      where the engine allows it; otherwise both renames in one transaction.
   7. Drop the sync trigger.
   8. Drop the old column. Kept as a separate, last step, marked "only after
      you have checked".
5. **Copy SQL**, or **Open in editor**, which opens the steps as a script.
   The editor's Safe mode then confirms each write, as it already does.

## Engines in v1

The Postgres family (PostgreSQL, CockroachDB, YugabyteDB, Redshift), the
MySQL family (MySQL, MariaDB, TiDB) and SQL Server / Azure SQL. That covers
most engines and three syntax families. The rest show "not yet for <engine>"
rather than a guess. SQLite needs a table rebuild instead of these steps, so
it comes later as its own plan.

## Where the code goes

- `packages/sql/src/modules/utilities/column-change.ts` (+ `.types.ts`,
  `.registry.ts`): a pure function `planColumnChange({ dialect, schema, table,
  column, change, batchSize })`, returning `{ impact, blockers, steps: [{ title,
  rerunSafe, sql }] }`. No I/O, so it lives in `@foxschema/sql` with the other
  utilities and is unit-tested per dialect.
- Per-dialect SQL behind the registry, following `index-fragmentation.registry.ts`.
- `apps/web/src/frontend/features/utilities/components/ColumnChangeModal.tsx`,
  shaped like `CloneTableModal`, reading schema through the existing schema API.
- No server route in v1: the plan is computed in the browser from the schema
  Fox already loads, and nothing runs.
- Add `utilities.columns` to `docs/feature-map/data.js` and `FEATURE_MAP.md`.
- A permission? None new: generating SQL is reading. Running it goes through
  the editor and its existing `editor.dml` / Safe-mode gates.

## Tests

- **Unit, per dialect:** the steps for rename, type change and both, golden
  SQL per family.
- **Impact:** inbound and outbound foreign keys, indexes, the primary key,
  views that mention the column.
- **Blockers and lossy conversions are flagged.**
- **Live, per engine in the dialect e2e suites:** run the generated steps
  against the seeded `demo_a` table, then check the data, the indexes and that
  the old column is gone. This is the test that proves the SQL, not only that
  it renders (the same rule as `helpers/sql-exec.ts`).
- **Web:** pick, impact list, steps render, Copy and Open in editor.

## Later (v2)

Running the steps from the app: batches with progress, resume after failure,
the row-count check before switch-over, and a confirmation before the drop.
