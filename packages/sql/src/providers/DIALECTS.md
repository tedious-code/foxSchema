# SQL Dialect migration-generation checklist

Per-dialect plan for the `SqlDialect` strategy used by `sql-generator.module.ts`.
Use this when adding a dialect or chasing a "works on dialect X, breaks on Y" bug.
Each dialect lives in `providers/<name>/<name>.sql-dialect.ts`.

## The `SqlDialect` contract

**Required** (every dialect): `identityClause`, `addColumnStatement`,
`modifyColumnStatements`, `dropColumnStatement`, `setDefaultStatements`,
`dropPrimaryKeyStatements`, `parseType`, `renderType`.

**Optional hooks** (omit ⇒ generator uses a generic fallback):

| Hook | Generic fallback | Override when |
|------|------------------|---------------|
| `dropIndexStatement` | `DROP INDEX schema.name;` | engine needs `... ON table` or `IF EXISTS` |
| `dropTriggerStatement` | `DROP TRIGGER schema.name;` | engine needs `... ON table`, `IF EXISTS`, or bare name |
| `createTriggerStatement` | emit stored `definition` verbatim | provider stores only the trigger *body*, not full `CREATE TRIGGER` |
| `dropForeignKeyStatement` | `ALTER TABLE t DROP CONSTRAINT IF EXISTS name;` | engine lacks `DROP CONSTRAINT [IF EXISTS]` |
| `serialSequenceFromDefault` | no pre-created sequence | serial columns reference a backing sequence (Postgres) |
| `dropDependentViewsBlock` / `recreateDependentViewsBlock` | none | ALTER/DROP COLUMN fails while a view depends on the column (Postgres) |
| `nullableTypeWrapper` | append `NULL`/`NOT NULL` | nullability is encoded in the type (ClickHouse `Nullable(T)`) |
| `inlinePrimaryKeyConstraint` | emit `PRIMARY KEY (cols)` inside CREATE TABLE | engine rejects a table-level PK (ClickHouse: only CHECK/ASSUME there) |
| `createTableSuffix` | none | clauses after the column list — ClickHouse `ENGINE = MergeTree ORDER BY …` |
| `addPrimaryKeyStatements` | `ALTER TABLE t ADD [CONSTRAINT] PRIMARY KEY (cols)` | engine cannot ADD PRIMARY KEY (ClickHouse: `-- review:` recreate) |
| `engineChangeStatements` | none | ENGINE / ORDER BY changed and cannot ALTER in place (ClickHouse) |
| `quoteIdentifier` | ANSI `"name"`, embedded `"` doubled | engine uses another wrapper — MySQL/MariaDB/TiDB backticks, SQL Server/Azure brackets |
| `roleMemberStatement` | `GRANT role TO member;` / `REVOKE role FROM member;` | engine does not take the standard form — Db2 names the member kind, SQL Server uses `ALTER ROLE … ADD MEMBER` |
| `createTypeStatement` | DB2-style `CREATE TYPE … AS (…) MODE DB2SQL` / `AS base WITH COMPARISONS` | engine has its own type syntax (PostgreSQL ENUM / composite / DOMAIN, SQL Server alias) |
| `dropTypeStatement` | `DROP TYPE [IF EXISTS] name;` | engine drops some kinds with another statement (PostgreSQL `DROP DOMAIN`) |
| `postColumnChangeStatements` | none | table needs maintenance after column changes before its keys/indexes are rebuilt (DB2 `REORG`) |

## Cross-cutting invariants (generator-level, not per dialect)

- **Casing**: `obj.tableName` is the *uppercased match key* from `compare.module.ts`
  (`key()`), **not** a real identifier. Always reference the table via
  `source.name` / `targetTable?.name` (native casing) so CREATE TABLE and the
  following CREATE INDEX / ALTER / trigger statements agree — critical on
  case-sensitive MySQL (Linux, `lower_case_table_names=0`).
- **Identifier quoting**: names come from a live catalog, so they can hold spaces,
  punctuation or non-ASCII letters (`Order Details` ships with Northwind). The
  generator quotes an identifier **only when it cannot be written bare**
  (`isBareIdentifier`), which is why ordinary names are emitted exactly as before.
  `ident()` is idempotent, so pre-quoting a name before handing it to a dialect hook
  is safe — that is how ADD COLUMN and CREATE INDEX are fixed for all 14 at once.
  Matching the delimiters alone is **not** enough to treat a name as already
  quoted: a hostile catalog name that *looks* wrapped (`"a"); DROP TABLE t; --"`)
  is sent through the dialect quoter, not emitted verbatim
  (`isWellFormedQuotedIdentifier`). Line breaks in a name are flattened to
  spaces (`flattenIdentifier`) — they cannot be escaped inside quotes and they
  end a `--` review note, leaving the rest of the name as a statement. Dialect
  hooks that write their own `-- review:` notes should not put a raw catalog
  name into a comment; `keepCommentCommented` is the backstop.
- **Column names in a diff**: `ColumnDiff.name` is the uppercased match key, exactly
  like `tableName`. Use `source?.name ?? target?.name` for DDL, or you rename the
  user's `new col` to `NEW COL`.
- **FK capability**: `dialectSupportsFk(name)` is authoritative. When `alterAdd` is
  false (SQLite, ClickHouse) the generator inlines the constraint in CREATE TABLE if
  `createInline`, and otherwise emits `-- review:` — never `ALTER TABLE ... ADD
  CONSTRAINT`, which those engines reject outright.
- **Index / trigger / FK names** emitted into a statement must be **bare**
  (`bareName`) — they live in the qualified table's schema; a schema-qualified
  index name is a syntax error in PG/MySQL/SQL Server.
- **FK dependency order**: ADDED tables are topologically sorted
  (`sortAddedByDependency`) so a referenced table is created before its referencer
  (e.g. `orders` before `order_items`). Cycles broken arbitrarily.
- **Drop order in ALTER**: drop FK constraints → drop indexes → column changes →
  re-add PK → re-add indexes → re-add FKs → triggers. Don't reorder casually.
- **Defaults**: provider must hand back a *renderable* default (quoted for string
  types). Cross-dialect, a default expression is flagged `-- review:` not emitted.
- **Cross-dialect procedural objects** (VIEW/FUNCTION/PROCEDURE/TRIGGER) are emitted
  as a `MANUAL REVIEW REQUIRED` comment block, never auto-translated.

## Per-dialect notes

### MySQL / MariaDB (`mysql.sql-dialect.ts`, shared)
- Case-sensitive table names on Linux — see casing invariant above.
- PK constraint is always named `PRIMARY`; `renderCreateTable` skips the
  `CONSTRAINT <name>` clause for that reserved name.
- `modifyColumnStatements` = `MODIFY COLUMN` and **must re-state** `NOT NULL` +
  `AUTO_INCREMENT` (MODIFY replaces the whole column definition).
- `dropIndexStatement` ⇒ `DROP INDEX name ON table`.
- `dropTriggerStatement` ⇒ `DROP TRIGGER IF EXISTS name` (no `ON table`).
- `createTriggerStatement` ⇒ wrap body-only `ACTION_STATEMENT`.
- `dropForeignKeyStatement` ⇒ `ALTER TABLE t DROP FOREIGN KEY name`
  (no `DROP CONSTRAINT IF EXISTS` in MySQL).
- ⚠️ **CREATE FUNCTION + binary logging (error 1419)**: with binlog on and no
  `SUPER`/`SYSTEM_VARIABLES_ADMIN`, MySQL refuses CREATE FUNCTION unless the routine
  is declared `DETERMINISTIC`/`NO SQL`/`READS SQL DATA`. We do **not** wrap routines
  with `SET GLOBAL log_bin_trust_function_creators` — that statement *also* needs the
  privilege the user lacks, so it can't help (and would itself fail mid-migration).
  Routine bodies are emitted verbatim; the prerequisite is environmental: a privileged
  user/DBA sets `log_bin_trust_function_creators=1` (session or my.cnf) once before the
  deploy, or the source routines carry a characteristic clause. (Decision: user/DBA
  owns the server flag; tool stays out of it.)
- Provider gotchas: `ROUTINE_DEFINITION` can be NULL w/o `SHOW_ROUTINE` →
  `SHOW CREATE FUNCTION/PROCEDURE` fallback. `COLUMN_DEFAULT` stores string
  defaults unquoted → `normalizeDefault()`.

### PostgreSQL (`postgres.sql-dialect.ts`)
- `serialSequenceFromDefault` — create backing sequence before the table/column;
  `OWNED BY` ties its lifecycle.
- `dropDependentViewsBlock` / `recreateDependentViewsBlock` — guard ALTER/DROP
  COLUMN against view dependencies.
- `dropIndexStatement` / `dropTriggerStatement` use `IF EXISTS` (+ `ON table` for
  triggers). `DROP CONSTRAINT IF EXISTS` fallback is correct — no FK override needed.
- Provider: `timestamp without/with time zone`, `character varying`, `bytea` mapping.
- Types: ENUM (`E`), composite (`O`, standalone `CREATE TYPE … AS (…)` only — a
  table's own row type is not one) and DOMAIN (`D`). A domain is `CREATE DOMAIN`
  with its `DEFAULT`, `NOT NULL` and named `CHECK`s (`userType.domain`), and is
  dropped with `DROP DOMAIN` — PostgreSQL refuses `CREATE TYPE x AS base` and
  `DROP TYPE` on a domain.

### SQL Server / Azure SQL (`sqlserver.sql-dialect.ts`; azure re-exports it)
- **`sp_rename` and `ALTER COLUMN` are refused for a column a filtered index names** in its `WHERE` ("one or more objects access this column"), indexed or not. Fox's SQL Server index model has no filters; Rename Column scripts such indexes from `sys.indexes` when it runs.
- `modifyColumnStatements` = `ALTER COLUMN`, must re-state nullability + `IDENTITY(1,1)`.
- `dropIndexStatement` ⇒ `DROP INDEX name ON table`.
- `dropTriggerStatement` ⇒ `DROP TRIGGER IF EXISTS schema.name`.
- Default fallback `DROP CONSTRAINT IF EXISTS` is valid on SQL Server 2016+.
- Provider: `normalizeSSDefault()` strips wrapping parens (`('active')`, `((0))`).

### Oracle (`oracle.sql-dialect.ts`)
- `modifyColumnStatements` = `MODIFY`, restate nullability.
- `dropIndexStatement` / `dropTriggerStatement` schema-prefixed, **no** `IF EXISTS`,
  **no** `ON table`.
- `createTriggerStatement` — reconstruct from body-only `TRIGGER_BODY`, parsing
  `TRIGGER_TYPE` (BEFORE/AFTER/INSTEAD OF, EACH ROW) + `TRIGGERING_EVENT`.
- `dropForeignKeyStatement` ⇒ plain `ALTER TABLE t DROP CONSTRAINT name` (Oracle has
  no `IF EXISTS`; a missing FK is a real error to surface).

### DB2 (`db2.sql-dialect.ts`) — primary target
- **Reorg-pending**: `DROP COLUMN` (and some type changes) leave the table in a state
  where `SELECT` still works but every INSERT/UPDATE/DELETE — and every index/key
  rebuild — fails with **SQL0668N reason code 7** until `REORG` runs. Because reads
  keep working, a migration without it looks successful and hands back a table nobody
  can write to. `postColumnChangeStatements` emits
  `CALL SYSPROC.ADMIN_CMD('REORG TABLE …')` before the keys/indexes are rebuilt.
  Bare `REORG TABLE` is a CLP command, not SQL, and cannot be sent over a connection.
- **Index reorg (Utils / Edit table):** Db2 cannot reorganise a single index
  (`REORG INDEX name` → SQL0270N reason 89). Defrag emits
  `CALL SYSPROC.ADMIN_CMD('REORG INDEXES ALL FOR TABLE …')` then `RUNSTATS`
  (`providers/db2/db2.index-fragmentation.ts`). Quote names as `SYSCAT` stores
  them: fold the **schema** to uppercase (it is what the user typed in the
  connection, and schema browse looks it up with `toUpperCase()`), but quote the
  **table exactly as given** — every caller passes the name schema browse read
  from `SYSCAT.TABLES`. Do not fold the table, single-case or not: a table
  created as `"orders"` would be aimed at `ORDERS` — SQL2211N if there is none,
  someone else's table if there is (`db2ReorgTarget`). Quoting the typed schema
  case (`"demo_a"."ORDERS"`) is SQL2211N for a table the probe just listed.
- `modifyColumnStatements` — `SET DATA TYPE` can't carry nullability; emit a
  **separate** `SET NOT NULL` / `DROP NOT NULL`.
- `dropIndexStatement` / `dropTriggerStatement` schema-prefixed, no `ON table`.
- Triggers stored as full `CREATE TRIGGER` ⇒ no `createTriggerStatement` needed.
- `dropForeignKeyStatement` ⇒ `ALTER TABLE t DROP FOREIGN KEY name` (no `IF EXISTS`).

### SQLite (`sqlite.sql-dialect.ts`)
- `RENAME COLUMN` (3.25+) rewrites the indexes, views and triggers that name the column itself (Rename Column relies on this, checked live).
- No `ALTER COLUMN` for type/nullability, no `ALTER` default, no `DROP PRIMARY KEY`
  ⇒ those hooks emit `-- review:` comments (table must be recreated), never invalid SQL.
- `dropIndexStatement` / `dropTriggerStatement` ⇒ `IF EXISTS`, bare name (global namespace).
- `dropForeignKeyStatement` ⇒ `-- review:` note (SQLite can't drop a constraint in
  place; the table must be recreated), never invalid SQL.

### Redshift (`redshift.sql-dialect.ts`)
- Postgres subset. `modifyColumnStatements` ⇒ `-- review:` (no in-place ALTER type).
- `IDENTITY(seed,step)` on the column. `dropIndex/Trigger` Postgres-style with `IF EXISTS`.

### ClickHouse (`clickhouse.sql-dialect.ts`)
- A sorting-key column cannot be renamed or retyped. `MODIFY COLUMN` keeps the default and comment; a nullable column must stay `Nullable(T)` — `LowCardinality(Nullable(T))` for dictionary encoding — or its NULLs fail to convert.
- `nullableTypeWrapper` ⇒ `Nullable(T)`; generator skips `NULL`/`NOT NULL` keywords.
- **No table-level `PRIMARY KEY` constraint.** ClickHouse only allows `CHECK` /
  `ASSUME` inside the column list; `CONSTRAINT PRIMARY_KEY PRIMARY KEY (id)` is
  `Syntax error … Expected one of: CHECK, ASSUME`. `inlinePrimaryKeyConstraint`
  is false. Logical PK columns (and captured `orderBy`) become
  `ENGINE = MergeTree ORDER BY id` via `createTableSuffix`. A composite logical
  PK (`order_id, coupon_id`) is `ORDER BY (order_id, coupon_id)` — ClickHouse
  MergeTree supports multi-column keys that way, not as a table constraint.
  When the logical PK is a prefix of a longer `orderBy`, ClickHouse also gets
  `PRIMARY KEY id` on the engine clause (not inside the column list). A captured
  `engine` (e.g. `ReplacingMergeTree`) is used as-is; no key → `ORDER BY tuple()`.
  **ORDER BY / PRIMARY KEY identifiers are quoted** (`ident`) unless they came
  from `system.tables.sorting_key` (`orderByFromCatalog: true`) — that value is
  already valid SQL (expressions, `tuple()`, a name ClickHouse quoted itself)
  and must stay verbatim. An unmarked key is a column name from
  `system.columns.is_in_sorting_key` and must not reach the ENGINE clause raw
  (a name containing `)` would close the clause and append DDL).
- Changing PK / ENGINE / ORDER BY in place is impossible — `dropPrimaryKeyStatements`,
  `addPrimaryKeyStatements`, and `engineChangeStatements` emit `-- review:` to
  recreate the table, never `ALTER TABLE … ADD PRIMARY KEY`.
- Provider reads `system.tables.engine / sorting_key / primary_key` plus
  `system.columns.is_in_primary_key / is_in_sorting_key`. Compare treats engine
  and ORDER BY as table-level changes; other dialects omit those fields and
  stay UNCHANGED.
- No traditional indexes/triggers/FKs — those hooks are absent by design.
- No transactions: the adapter's begin/commit/rollback are no-ops, so
  `clickhouse.settings.ts` sets `transactions: false` (as Redis and MongoDB do).
  `POST /sql/execute` refuses `transaction: true` there and the editor runs the
  batch statement by statement with a warning. `POST /data-migrate/execute`
  refuses `useTransaction: true` the same way, and Data migrate shows its
  Transaction checkbox off and disabled.

### Wire-compatible variants — CockroachDB / YugabyteDB / TiDB
- **CockroachDB `ALTER COLUMN … TYPE`:** an explicit `USING` forces a column rewrite, and a rewrite is refused for a column in an index ("not supported for columns that are part of an index"). Without `USING`, lengthening a string is a metadata change. General conversions need `SET enable_experimental_alter_column_type_general = true`.
- **CockroachDB** (`cockroachDb/`) and **YugabyteDB** (`yugabyteDb/`) are PostgreSQL
  wire/catalog compatible: their `.sql-dialect.ts` **re-exports `postgresSqlDialect`**,
  their provider **subclasses `PostgresProvider`** (only `provider` id differs), and
  they alias the **`pg` adapter** in `adapter-registry.ts`.
- **TiDB** (`tiDb/`) is MySQL compatible: `.sql-dialect.ts` **re-exports `mysqlSqlDialect`**,
  provider **subclasses `MysqlProvider`**, aliases the **`mysql2` adapter**.
- Only settings differ (label + default port: Cockroach 26257, Yugabyte 5433, TiDB 4000).
- These have **no per-dialect DDL overrides yet** — they inherit the base strategy.
  Add method overrides on the subclass (as `MariadbProvider` refines roles/sequences)
  or a standalone `.sql-dialect.ts` only when a real divergence surfaces.

### DuckDB (`duckDb/duckdb.sql-dialect.ts`, full provider)
- **Any index on a table blocks every `ALTER` on it** — a rename of an unrelated column included ("Cannot alter entry … entries that depend on it"). A primary key does not. `duckdb_indexes()` is read without its columns, so an index cannot be rebuilt from the model; Rename Column refuses and names the indexes.
- Embedded (file path connection, like SQLite) but schema-aware with Postgres-
  flavored SQL. Introspects via `information_schema` + `duckdb_constraints()` /
  `duckdb_indexes()` / `duckdb_views()` / `duckdb_sequences()` / `duckdb_types()`.
- No triggers/stored procedures/functions (those maps are empty).
- Enum introspection: filter `duckdb_types()` to `logical_type='ENUM' AND labels
  IS NOT NULL AND type_name<>'enum'` — DuckDB also lists an anonymous `enum` type
  (null labels) per enum-typed column.
- `duckdb_views().sql` is the FULL `CREATE VIEW … AS <body>` — the provider strips
  the header so `definition` is just the body (else the generator double-CREATEs).
- No `GENERATED … AS IDENTITY` (uses sequences), so `identityClause` returns ''.
  Types render UPPERCASE DuckDB names; binary is BLOB (not bytea).

## Adding a dialect — checklist

1. Create `providers/<name>/<name>.sql-dialect.ts` with `makeDialectTypeFns` tables
   + the 6 required statement hooks.
2. Decide each optional hook from the table above; **default is often wrong** for
   DROP INDEX/TRIGGER/FK and for body-only triggers — verify against real DDL.
3. `modifyColumnStatements` must preserve **nullability + identity** (MODIFY/ALTER
   COLUMN usually replaces the full definition).
4. Register in `modules/dialect/registry.ts` + `adapter-registry.ts`.
   If the engine has accounts, add `<name>.user-sql.ts` and register it in
   `modules/access/user-sql.registry.ts`. If it has GRANT/REVOKE, add
   `<name>.access-sql.ts` (or re-export an existing emitter) in
   `modules/access/access-sql.registry.ts`. Backup/restore commands live in
   `<name>.backup.ts` and `modules/utilities/backup.registry.ts` — Fox Schema
   writes the commands (shell or SQL); `runsOn` says whether the file lands on
   the client, the database server, or a cloud snapshot. Only a server-side SQL
   backup is ever run (from the panel, after confirmation); add `history` when
   the engine records its backups, so the panel can list them and restore one.
   Restores are never run. Commands must not contain a password.
   Rename Column: `<name>.column-change.ts` in
   `modules/utilities/column-change.registry.ts`. Implement `alterTypeSteps`
   (in-place default) and, if the engine can, `rebuildSteps` + `progressSql`
   (large-table mode). A change it cannot make is `refuse`, not SQL that
   fails there. Omit the engine to answer "not yet".
5. Say how the engine lexes SQL in `modules/sql-text/sql-readings.ts`: its
   comments, quotes, escapes and name characters, and every reading a server
   setting can switch it to. The permission gate classifies each statement
   under all of them. A dialect missing there gets every reading of every
   dialect, which is safe but slow.
6. Add a round-trip test in `type-mapping.test.ts` and a generator assertion.
7. Run `npx vitest run` (repo root) + `cd apps/web && npx tsc --noEmit`.
