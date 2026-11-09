# Safe column change: plan and SQL for review

> **Shipped.** Planner (#588), Utilities → **Rename Column** (#589), Run /
> Execute all (#595), in-place type change as the default (#600), and all 14
> SQL engines (2026-11-08). Living docs: [user-guide.md](../user-guide.md#utilities),
> [FEATURE_MAP.md](../FEATURE_MAP.md) (`utilities.columns`),
> [CODE_MAP.md](../CODE_MAP.md), [ARCHITECTURE.md](../ARCHITECTURE.md).
> The “Fox runs nothing” / “engines in v1” lines below are history; the
> current behaviour is **Direct by default** and **Every SQL engine**.

Board card: `safe-column-change`, feature id `utilities.columns`. Decided
on 2026-11-01: v1 shows what a change touches and generates the SQL to
review, copy or open in the editor. Run / Execute all and in-place type
change shipped afterwards; this page keeps the original plan for history.

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

## Later (v2) — partly shipped

Running the steps from the app is in three parts: add the nullable column,
copy with **processed / total**, then constraints / triggers / description.
Each part’s SQL can be copied or Run (Safe mode confirms). Resume-after-failure
and a dedicated confirm before drop are still later.

## v1 as built (2026-11-02): the planner

`planColumnChange` in `packages/sql/src/modules/utilities/column-change.ts`,
with one provider file per engine family, registered in `column-change.registry.ts`.
Differences from the plan above, all from running the generated SQL live:

- **A rename alone is one step**, `RENAME COLUMN` (or `sp_rename`). Every
  engine here renames in place, instantly, so the add-copy-switch dance is
  only for type changes.
- **The sync trigger comes before the copy**, so writes during the copy reach
  the new column. CockroachDB and TiDB get no trigger; the plan says to run
  the copy once more just before the switch-over.
- **Redshift is not in v1.** Its `ALTER TABLE` lacks `ADD COLUMN IF NOT EXISTS`
  and `SET NOT NULL`. It answers "not yet" rather than SQL that fails there.
- **MySQL and SQL Server need both sides of a foreign key to have the same
  type.** The planner refuses a type change on a foreign-key column when the
  referenced column would keep another type, naming it. PostgreSQL only needs
  comparable types, so it allows it. MySQL running the plan without this
  check failed at the constraints step: "incompatible".
- **SQL Server's switch-over is one batch.** Drivers send each statement as
  its own batch, and SQL Server refuses a batch that ends inside a
  transaction, so `BEGIN TRANSACTION … COMMIT` is one statement, with
  `XACT_ABORT ON`. Its DEFAULT constraint is found by name and dropped through
  `sp_executesql`, since `EXEC()` takes no function calls.
- **Also refused for now:** a primary key column, a column other tables'
  foreign keys reference, an identity column, and a type change on a table
  without a primary key (the copy batches through it).

Live runs (seeded `demo_a.orders`, 11 rows, batches of 3), every step through
`POST /api/sql/execute`:

| Engine | Change | Result |
|---|---|---|
| PostgreSQL | `status` enum → `varchar(30)`, renamed `state` (NOT NULL, default, index) | All 7 steps; the trigger carried a write made during the copy; data identical; index back under its name; nothing left behind |
| PostgreSQL | `notes` renamed `note` | One step |
| MySQL | `status` varchar(20) → varchar(40), renamed `state` | All 7 steps, as above |
| MySQL | `total` decimal(12,2) → decimal(14,2), used by a view | All 7 steps; the view reads the new column |
| MySQL | `customer_id` int → bigint (foreign key to `customers.id` int) | Refused by the planner, with the reason |
| SQL Server | `status` nvarchar(20) → nvarchar(40), renamed `state` (NOT NULL, DEFAULT constraint, index) | All 7 steps, as above |

The Utilities → Change Column screen shipped in #589.

## Direct by default, copy as large-table mode (2026-11-08)

The add-copy-switch plan is right for a big, busy table and too much for most.
A type change is now **one in-place ALTER by default**; the copy plan above is
**large-table mode**, a checkbox shown once a new type is typed in. Its batch
size field only appears with it. A rename alone is unchanged.

- **Direct steps per engine** (`alterTypeSteps` on each `ColumnChangeDialect`):
  - PostgreSQL / YugabyteDB: `ALTER COLUMN … TYPE … USING col::type`. NOT NULL,
    the default, the comment and indexes stay with the column. PostgreSQL
    refuses while a view uses the column (`viewsBlockTypeChange`), so the plain
    "views may use" warning becomes "drop it first and recreate after".
  - CockroachDB: the same, after `SET enable_experimental_alter_column_type_general = true`.
  - MySQL / MariaDB / TiDB: `MODIFY COLUMN`, which drops whatever it does not
    restate, so it restates NOT NULL, the default and a character collation,
    and keeps the comment by reading it from `information_schema` in a
    prepared statement (the same trick the copy path uses for the new column).
  - SQL Server / Azure SQL: `ALTER COLUMN` refuses while an index, a foreign
    key or a default sits on the column, so the step is one batch in one
    transaction: drop them, alter, put them back. The indexes are **scripted
    from the catalog as it runs**: Fox's index model has no filter, included
    columns or sort order, and recreating from it turned a filtered unique
    index into an unfiltered one in the live run. The catalog script also finds
    an index that only INCLUDEs the column, which the model misses and which
    blocks the ALTER too. Fill factor, compression and partitioning are not
    carried over.
- **Kept:** the data-loss check (the lossy warning and its acknowledgement)
  and the foreign-key-types check. **New:** a size warning from the catalog's
  row estimate and size (`fetchTableInsight`): from 1 million rows or 1 GB,
  the plan warns that the ALTER can rewrite the table and block writes, and
  points at large-table mode. Unknown size, no warning.
- **Only large-table mode** needs a primary key and free `__new` / `__old`
  names. An identity column is still refused in both modes.
- **A type change alone lists no line-by-line references.** Views, triggers,
  functions and procedures that may use the column keep their one-line
  warnings; the detailed lines (`impact.dependents`) are for a rename, where
  stored SQL must say the new name.

Live runs (2026-11-08), every step through Fox's own reader and splitter:

| Engine | Change | Result |
|---|---|---|
| PostgreSQL 16 | `status` varchar(20) → varchar(40), `qty` int → bigint, `pid` int → bigint (foreign key) | One ALTER each; NOT NULL, default and comment kept. A view on the column made the ALTER fail, as the warning says |
| MySQL 8 | `status` varchar(20) utf8mb4_bin → varchar(40), `qty` int → bigint | NOT NULL, default, collation and both comments kept |
| SQL Server 2022 | `status` (default, DESC index with INCLUDE), `qty` (filtered unique index, included elsewhere), `note`, `extra` (only INCLUDEd) | All four changed; every index back with its sort order, includes and filter. `note` varchar → int with a value `'hi'` failed and rolled back whole, indexes intact |

**Large-table mode on SQL Server, fixed the same day.** It too recreated
indexes from the model (losing filters), and its switch-over could never pass a
filtered index: **SQL Server will not `sp_rename` a column a filter names**
("one or more objects access this column"), whether the column is indexed or
only in the `WHERE`. Now the constraints step copies only unfiltered indexes,
scripted from the catalog, as `<name>__new` on the new column. The switch-over
batch moves the filtered ones: it drops them, renames both columns, and
rebuilds them on the new column with the filter rewritten, all in one
transaction. The drop step is one batch too: it drops the old column's
indexes from the catalog, drops the column, and gives the `__new` ones their
names back. An index counts when the column is a key, an INCLUDE or in its
filter (`CHARINDEX(QUOTENAME(col), filter_definition)`), in both modes. Live,
SQL Server 2022, with a DESC index with INCLUDE, a filtered unique index, a
filter-only index (`ON (id) WHERE qty > 0`) and an INCLUDE-only column: all
four changes ran in both modes, and every index came back under its own name,
filter and options intact. A plain rename alone still hits the `sp_rename`
rule; that belongs with the rename rewrite work.

## Every SQL engine (2026-11-08)

Rename Column now covers all 14 SQL dialects. The six added do the change in
place only; large-table mode stays with the eight that have it, and the screen
hides it elsewhere (`columnChangeLargeTable`). A dialect can refuse a change it
cannot make, with its reason, before any SQL is shown (`refuse` on
`ColumnChangeDialect`).

| Engine | Rename | Type change |
|---|---|---|
| Oracle | `RENAME COLUMN` | `MODIFY (col type)`, no NULL clause (restating NOT NULL is ORA-01442). Lengths and precision only on a table with data (ORA-01439 across kinds, ORA-01441 below the longest value) |
| Db2 | `RENAME COLUMN` | `SET DATA TYPE`, then `CALL SYSPROC.ADMIN_CMD('REORG TABLE …')`. Without it the next write fails with SQL0668N reason 7 (checked live) |
| SQLite | `RENAME COLUMN`; SQLite rewrites the index, view and trigger that name it (checked live) | Refused: it needs a table rebuild, not covered yet |
| DuckDB | `RENAME COLUMN` | `ALTER COLUMN … TYPE … USING CAST(…)`. Both refused while the table has **any** index: DuckDB will not alter it ("entries that depend on it"), and Fox's DuckDB index model has no columns to rebuild one from. A primary key does not count |
| Redshift | `RENAME COLUMN` | Only lengthening a VARCHAR (`ALTER COLUMN … TYPE varchar(n)`); anything else refused with the reason |
| ClickHouse | `RENAME COLUMN` | `MODIFY COLUMN`; a nullable column stays `Nullable(…)`, inside `LowCardinality(…)` when that is asked for. A sorting-key column is refused for both, with ClickHouse's reason ahead of the general primary-key one |

Also from the live runs: the PostgreSQL family now writes `USING col::type`
only when the kind of type changes (text to number). An explicit `USING` made
CockroachDB rewrite an indexed column it would otherwise only relabel, and it
refuses to rewrite one that is part of an index. The type-kind reading moved
to `column-type-shape.ts`, and it now reads ClickHouse's `Int16`–`Int256`,
`Float32/64` and its `Nullable(…)` / `LowCardinality(…)` wrappers for the
data-loss check.

Live runs, direct mode, through Fox's own reader, planner, splitter and drivers:

| Engine | Result |
|---|---|
| SQLite (file) | Rename ran; the index, view and trigger were rewritten to the new name and kept working; a type change was refused |
| DuckDB (file) | Two type changes and a rename ran, NOT NULL and defaults kept. With an index on the table, all three refused with the reason |
| ClickHouse 24.8 | `Int32` → `Int64`, `LowCardinality(Nullable(String))`, a rename: defaults and comments kept. The sorting-key column refused |
| Oracle 23 Free | Two `MODIFY`s and a rename, NOT NULL, default and comment kept; the index valid, the view marked invalid until next use |
| Db2 | Three `SET DATA TYPE` + `REORG` and a rename; writes and the view work after. A `SET DATA TYPE` without the REORG left the table reorg-pending |
| CockroachDB | Lengthened an indexed varchar in place (after the `USING` fix) and a rename |
| MariaDB 11, TiDB 8.5 | `MODIFY` kept the collation, NOT NULL, default and comments; a rename |

**Not run live:** Redshift (the local container is plain PostgreSQL, which
proves nothing about Redshift) and YugabyteDB (its container never answered a
query: the stale-masters problem in RUNNING_E2E.md, fixed by recreating its
volume).

Oracle, again after the volume was recreated (the old one carried timezone
file v45, which the current image does not ship, so every `DROP` failed with
ORA-01804): the same run passed and cleaned up after itself, and on a scratch
table shortening below the longest value failed with ORA-01441 and a NUMBER to
VARCHAR2 change with data with ORA-01439, as the step's note says.
