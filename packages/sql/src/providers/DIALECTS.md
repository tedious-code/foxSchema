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
| `quoteIdentifier` | ANSI `"name"`, embedded `"` doubled | engine uses another wrapper — MySQL/MariaDB/TiDB backticks, SQL Server/Azure brackets |
| `roleMemberStatement` | `GRANT role TO member;` / `REVOKE role FROM member;` | engine does not take the standard form — Db2 names the member kind, SQL Server uses `ALTER ROLE … ADD MEMBER` |
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

### SQL Server / Azure SQL (`sqlserver.sql-dialect.ts`; azure re-exports it)
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
- `modifyColumnStatements` — `SET DATA TYPE` can't carry nullability; emit a
  **separate** `SET NOT NULL` / `DROP NOT NULL`.
- `dropIndexStatement` / `dropTriggerStatement` schema-prefixed, no `ON table`.
- Triggers stored as full `CREATE TRIGGER` ⇒ no `createTriggerStatement` needed.
- `dropForeignKeyStatement` ⇒ `ALTER TABLE t DROP FOREIGN KEY name` (no `IF EXISTS`).

### SQLite (`sqlite.sql-dialect.ts`)
- No `ALTER COLUMN` for type/nullability, no `ALTER` default, no `DROP PRIMARY KEY`
  ⇒ those hooks emit `-- review:` comments (table must be recreated), never invalid SQL.
- `dropIndexStatement` / `dropTriggerStatement` ⇒ `IF EXISTS`, bare name (global namespace).
- `dropForeignKeyStatement` ⇒ `-- review:` note (SQLite can't drop a constraint in
  place; the table must be recreated), never invalid SQL.

### Redshift (`redshift.sql-dialect.ts`)
- Postgres subset. `modifyColumnStatements` ⇒ `-- review:` (no in-place ALTER type).
- `IDENTITY(seed,step)` on the column. `dropIndex/Trigger` Postgres-style with `IF EXISTS`.

### ClickHouse (`clickhouse.sql-dialect.ts`)
- `nullableTypeWrapper` ⇒ `Nullable(T)`; generator skips `NULL`/`NOT NULL` keywords.
- No traditional indexes/triggers/FKs — those hooks are absent by design.

### Wire-compatible variants — CockroachDB / YugabyteDB / TiDB
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
   writes the commands (shell or SQL) and never runs them; `runsOn` says
   whether the file lands on the client, the database server, or a cloud
   snapshot. Commands must not contain a password.
5. Add a round-trip test in `type-mapping.test.ts` and a generator assertion.
6. Run `npx vitest run` (repo root) + `cd apps/web && npx tsc --noEmit`.
