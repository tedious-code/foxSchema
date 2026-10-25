# Data Compare at 2,000 rows, and a SQL Tracer — 2026-10-17

**Status: plan, decisions taken 2026-10-18** (see the end). Part 3 (Redis
keys as tables) is built on branch `feat/redis-tables`. Parts 1 and 2 are not
built yet; their test-and-fix passes are tracked in
[the feature and dialect test plan](2026-10-25-feature-and-dialect-test-plan.md).

Three requests, planned for every dialect Fox ships:

1. **Data Compare** should compare **2,000 records** between two servers and let
   the reader page through the result.
2. **Utilities** should get a **SQL Tracer**: watch the SQL a database runs,
   the way SQL Server Profiler does, on as many engines as each one allows.
3. **Redis** should show list keys and JSON documents as tables, not as a bare
   type name.

Part 1 is a contained change to code that already works. Part 2 is a new
feature with a capability matrix per engine; it is phased so that a useful
tracer ships on every SQL dialect first and engine-native capture follows.
Part 3 gives Redis the schema browsing it has never had, and rows for the key
types it skips today.

---

## Part 1 — Data Compare

### How it works today

Compare is not its own screen. It is a mode of the SQL editor's results:

- The same query runs on two or more destinations. **Compare data**
  (`ResultsPanel.tsx`) picks a source and a destination grid and aligns their
  rows by key columns (`resultKeyAlign.ts` → `alignResultGridsByKey`). Keys
  default to the table's PK/unique columns, then `id`, then the first shared
  column.
- Each aligned row is `match`, `update`, `insert`, `delete`, or `unresolved`.
  **Unresolved** means the row is on one side only, *and* the other side's
  result was cut short, so it may exist on a later page. Calling it an add would
  be a guess, and a wrong add is an INSERT of a row the destination already has.
- **Data migrate** (`DataMigrateBar.tsx`, `resultRowDiff.ts`) turns the
  classification into INSERT/UPDATE/DELETE ops and runs them on the destination
  (`POST /api/data-migrate/execute`), in one transaction or op by op, with an
  optional snapshot to restore.

The limits in force:

| Limit | Where | Value |
|---|---|---|
| Rows per page | `SqlEditorView` input, `clampMaxRows` on the server | default 200, max 5,000 |
| Pages cached per statement | `MAX_PAGES_PER_STATEMENT` | 5 |
| Migrate ops | `DATA_MIGRATE_ROW_CAP` (client) and the route (`> 500` refused) | 500 |
| Grid rendering | `DataGrid` virtualizes rows (`OVERSCAN = 8`) | not a limit |

### What goes wrong at 2,000 rows

1. **Compare only sees the page each side has loaded, and the pages do not
   line up.** Each side pages on its own with OFFSET, so page 2 of the source
   and page 2 of the destination cover different keys. Every one-sided row on
   a cut-short side becomes `unresolved`. Paging through a compare is
   therefore not meaningful today.
2. **Without an ORDER BY, OFFSET pages are not even stable.** Engines return
   unordered results in whatever order the plan produces, so page 2 can repeat
   or skip rows between runs, on either side.
3. **The workaround is to raise Rows/page to cover everything.** That works up
   to 5,000, but nothing tells the reader to do it, and the result is one long
   list with counts only. There is no way to look at just the differences, or
   page through them.
4. **Migrate stops at 500 ops.** Past that it points at Server Beam, a code-cell
   sample. A 2,000-row compare that finds 900 differences cannot be applied
   from the screen that found them.

### Goals and non-goals

- **Goal:** compare **2,000 rows per side** — a fixed window, not a setting —
  in one action, with every row classified (no `unresolved` inside the
  window), and page through the result.
- **Goal:** filter to the rows that matter (changed, only in source, only in
  destination) and step from one difference to the next.
- **Goal:** apply up to **2,000** migrate ops from the same screen.
- **Non-goal (here):** comparing whole tables of millions of rows. That is
  Phase C below, with a different algorithm.

### Design

#### A. A compare run fetches both sides whole, in key order

A **Compare** action (next to the existing toggle) re-runs the selected
statement on both destinations with:

- `ORDER BY <key columns>` appended, or the statement wrapped as
  `SELECT * FROM (<sql>) fox_c ORDER BY <keys>` when it has its own ORDER BY or
  is not a single-table SELECT. The server's page wrap (`sql-page-wrap.service.ts`)
  already speaks each dialect's paging (OFFSET/FETCH, TOP, FETCH FIRST, LIMIT),
  so the ordered, limited fetch goes through it rather than a new SQL builder.
- a limit of **2,001**: the fixed 2,000-row window plus one. The extra row says
  whether that side has more than the window.

Both results land in the existing alignment code unchanged. No new server
route is needed for this step; it is `/api/sql/execute` with a page size and
an ORDER BY.

#### B. Every row inside the window is classified

- If neither side overflowed, both are complete: every one-sided row is a real
  add or delete, as today when both grids are complete.
- If a side overflowed, rows past the **smaller of the two last keys** are
  `unresolved`; rows before it are classified. That boundary needs a key order
  both engines agree on:
  - **Numeric, date/time, UUID and binary keys**: compared in JavaScript after
    the normalization `resultValueKey.ts` already does. Safe on every dialect.
  - **Text keys**: engines sort text by their own collation (MySQL and SQL
    Server default to case-insensitive, Postgres to byte or ICU order), so
    a JS comparison could put the boundary in the wrong place. When a side
    overflows and a key column is text, mark **all** one-sided rows past the
    first one-sided row as `unresolved`, and say why. Correct, if conservative.
- The summary line states the window: "2,000 of 2,431 source rows compared
  (ordered by `id`)".

#### C. A paged, filterable compare view

The aligned result is at most 4,002 rows of plain arrays in memory. It is paged
**in the browser**, not by re-querying:

- Page size 50 / 100 / 200 / 500 (default 100), with Prev / Next and
  "page 3 of 20".
- Filter chips with counts for the **whole** window: All · Changed · Only in
  source · Only in destination · Unresolved · Matching.
- **Next difference / Previous difference** jumps across pages.
- The Sync checkboxes (which rows to migrate) keep their state across pages
  and filters, keyed by the row's key label (`rowKeyLabels`), as they are now.

`DataGrid` already virtualizes rows, so page size is about readability, not
rendering cost.

#### D. Migrate up to 2,000 ops

- Raise `DATA_MIGRATE_ROW_CAP` and the route's check from 500 to **2,000**
  (one constant shared through `@foxschema/sql` or `@foxschema/shared`, so
  client and server cannot drift again).
- Keep the transaction semantics: **Stop** runs all ops in one transaction,
  **Continue** commits each op. Progress already streams (`emit({ type:
  'start', total })`).
- The **snapshot before apply** (Restore) is taken in chunks of 500 keys, so a
  2,000-row snapshot does not become one oversized `WHERE key IN (…)`. Oracle
  limits an IN list to 1,000 expressions, and SQL Server parameters to 2,100.
- Past 2,000 ops, the existing Server Beam pointer stays.

#### E. Dialect notes

| Concern | Dialects | Handling |
|---|---|---|
| ORDER BY inside a wrapped subquery | SQL Server, Azure SQL | Needs TOP or OFFSET/FETCH; the page wrap already adds it. Verify against both. |
| Paging syntax | Oracle (FETCH FIRST 12c+), Db2 (FETCH FIRST), ClickHouse/SQLite/DuckDB/MySQL family (LIMIT) | Reuse the page wrap; add a test per dialect for "ordered, limited, +1". |
| Case-insensitive text keys | MySQL, MariaDB, TiDB, SQL Server, Azure SQL (default collations) | `ABC` and `abc` are one key there. Compare treats them as two, so migrating into one of these would collide with the existing row. Detect a CI collation on the destination key (catalog), and fold case when aligning against it, with a note. |
| Value normalization | MySQL `TINYINT(1)` vs boolean, Oracle `NUMBER` vs integer, timestamps with and without time zone, `DECIMAL` scale, JSON, binary | `resultValuesEqual` covers several; add a cross-dialect fixture per pair in the Phase A tests (below). |
| Large values | Oracle/Db2 CLOB/BLOB, SQL Server `(max)`, Postgres `bytea`/`text` | 2,000 rows of LOBs is heavy. The existing "ignore columns" option is offered up front when a selected column is a LOB type. |
| Duplicate keys | Any table without a PK | Already detected and skipped with a warning; keep. |
| Not applicable | Redis, MongoDB | Compare needs a key-aligned tabular result; out of scope. |

### Phases and tests

- **Phase A — compare run + paged view (all 14 SQL dialects).** Unit tests for
  the boundary rule (numeric, text, overflow on one side and on both), the
  filter counts, and Sync state across pages. Cross-dialect normalization
  fixtures. An e2e per dialect pair already seeded (`demo_a` vs `demo_b`):
  compare 2,000 rows with a known set of differences, page to the last
  difference, assert the counts. Add rows to the seed so each engine has
  more than 2,000 in one table (`scripts/seed/*`), or generate them in the
  test's `beforeAll`.
- **Phase B — migrate up to 2,000.** Raise the shared cap; route test for 2,000
  accepted and 2,001 refused; chunked snapshot test with an Oracle IN-list
  case; e2e applying 1,500 ops in one transaction and restoring.
- **Phase C (later) — whole-table compare.** Key-range chunks: fetch the next
  2,000 source keys after a cursor, then the destination rows in exactly that
  key range (the server's `seek` gains an upper bound), merge, repeat.
  Optionally a per-chunk checksum to skip identical chunks, **same-dialect
  only**: `md5(row::text)` (Postgres), `MD5(CONCAT_WS(…))` (MySQL family),
  `HASHBYTES` (SQL Server), `STANDARD_HASH` (Oracle), `HASH` (Db2 11.1+),
  `cityHash64` (ClickHouse), `hash()` (DuckDB). Across dialects the canonical
  row text differs, so checksums would always disagree. Text keys need the
  collation handling from E.

---

## Part 2 — SQL Tracer

### What exists to build on

- **Server Insights** (Utilities) has a `sessions` probe per dialect
  (`providers/<d>/<d>.dba-utilities.ts`, `POST /api/schema/dba-utility`): a
  snapshot of current sessions and their running statement, on all 14 SQL
  dialects. That is the seed of a live view.
- The **per-dialect module + registry** pattern (`table-insight`,
  `index-fragmentation`, `dba-utilities`) is exactly the shape a tracer needs.
- `dba-utility-remedy.ts` already turns "permission denied" into the grant the
  user is missing. The tracer needs the same.
- `ConnectionFactory` times every query Fox runs, but by contract never records
  SQL text (see `docs/BACKEND_ARCHITECTURE.md`). That contract stays; see the
  Fox activity log below.

### Four modes

| Mode | What it shows | How |
|---|---|---|
| **Live** | Statements running right now, refreshed every 1–2 s, with how long each has run | Poll the existing `sessions` probe and keep what was seen. Misses statements faster than the interval, and says so. |
| **Capture** (Profiler) | Every statement that completed during a window you start and stop: time, duration, user, database, client, rows, text | Engine-native, per the matrix below: a trace session, an event table, or a history the engine already keeps. |
| **Top statements** | What ran during the window, grouped by normalized statement: calls, total and mean time, rows | Snapshot an engine's statement statistics at start and stop, and diff them. Normalized text has no literals, which also makes it the safest mode. |
| **Fox activity** | Statements this Fox install ran on the connection, from any user | An in-memory ring buffer in the server, owners and admins, redacted, never written to logs. The only mode for SQLite and DuckDB, which have no server. |

### Capability matrix

"Native capture" is a true record of each completed statement. Privileges are
the least the engine needs. Every row is to be **verified on a live server**
before it ships, as the e2e workflow requires (see
`foxschema-e2e-workflow` notes on traps).

| Dialect | Live | Native capture | Top statements | Engine privilege | Caveats |
|---|---|---|---|---|---|
| **SQL Server** | `sys.dm_exec_requests` + `sql_text` (already the sessions probe) | **Extended Events**: `CREATE EVENT SESSION fox_trace_<id> ON SERVER` with `sql_batch_completed` + `rpc_completed`, actions for user/app/host/db, a `ring_buffer` target; read with XQuery over `sys.dm_xe_session_targets`; `DROP` on stop | `sys.dm_exec_query_stats` diff | `ALTER ANY EVENT SESSION` + `VIEW SERVER STATE` (2022: `CREATE/ALTER ANY EVENT SESSION`, `VIEW SERVER PERFORMANCE STATE`) | SQL Trace / Profiler is deprecated; XE is the supported path and lighter. |
| **Azure SQL** | `sys.dm_exec_requests` | **Database-scoped XE**: `CREATE EVENT SESSION … ON DATABASE`, `ring_buffer`, read from `sys.dm_xe_database_session_targets` | **Query Store** (on by default) | `ALTER ANY DATABASE EVENT SESSION`, `VIEW DATABASE STATE` | Server-scoped XE is not available in Azure SQL Database. |
| **PostgreSQL** | `pg_stat_activity` | No safe native capture without changing server logging. Optional, superuser only: `log_min_duration_statement = 0` read back via `pg_read_file` on `csvlog`. Off by default. | **`pg_stat_statements`** diff (needs the extension) | `pg_read_all_stats` to see other users' text | Without the extension, Top is unavailable; say so with the `CREATE EXTENSION` remedy. |
| **CockroachDB** | `crdb_internal.cluster_queries` | `crdb_internal.cluster_execution_insights` (slow/problem statements) | `crdb_internal.statement_statistics` diff | `VIEWACTIVITY` (or `VIEWACTIVITYREDACTED`, which hides literals) | Statement stats flush on an interval; the window is approximate. |
| **YugabyteDB** | `pg_stat_activity` | `yb_active_session_history` (2.20+) as sampled history | `pg_stat_statements` (on by default) | as Postgres | ASH is sampling, not a full record; label it. |
| **Redshift** | `STV_RECENTS` | **`SYS_QUERY_HISTORY`** (+ `SYS_QUERY_TEXT` for long text): the engine already records every query; capture = rows with `start_time` in the window | `SYS_QUERY_HISTORY` grouped | superuser, or `SYSLOG ACCESS UNRESTRICTED` to see other users | Rows appear after the query ends; poll every few seconds. |
| **MySQL** | `performance_schema.processlist` | **Performance Schema**: `events_statements_history_long` (turn the consumer on at start, restore at stop) with a high-water mark on `(THREAD_ID, EVENT_ID)`; falls back to `events_statements_history` (on by default, last 10 per thread) | `events_statements_summary_by_digest` diff | `SELECT` on `performance_schema`; `UPDATE` on `setup_consumers` to switch `history_long` | General log to a table works too but is global and heavy; not offered. |
| **MariaDB** | `information_schema.PROCESSLIST` | **General log to table**: `SET GLOBAL log_output='TABLE', general_log=1`, read `mysql.general_log`, restore both on stop | Performance Schema is off by default (startup-only); when on, as MySQL | `SUPER` / `SYSTEM_VARIABLES_ADMIN` | Global switch: logs every client's statements for the window. A loud warning, a short time box, and an exact restore of the prior values. |
| **TiDB** | `INFORMATION_SCHEMA.CLUSTER_PROCESSLIST` | `CLUSTER_SLOW_QUERY` (statements over `tidb_slow_log_threshold`, default 300 ms; lowering it to 0 is global and heavy) | **`CLUSTER_STATEMENTS_SUMMARY(_HISTORY)`** (on by default) | `PROCESS`, and `SELECT` on the info schema | Top statements is the primary mode on TiDB. |
| **Oracle** | `V$SESSION` + `V$SQL` | No license-free complete capture. `V$SQL` / `V$SQLSTATS` diff by `SQL_ID` (executions, elapsed time, last active) gives what ran, grouped. | `V$SQLSTATS` diff | `SELECT_CATALOG_ROLE` (or `SELECT` on `V_$SQL`, `V_$SQLSTATS`, `V_$SESSION`) | **`V$ACTIVE_SESSION_HISTORY` is never used**: it needs the Diagnostics Pack license (decided: left out). `DBMS_MONITOR` session traces write files on the server; out of scope. |
| **Db2** | `MON_GET_ACTIVITY` | **Activity event monitor**: `CREATE EVENT MONITOR fox_trace_<id> FOR ACTIVITIES WRITE TO TABLE`, plus `COLLECT ACTIVITY DATA` on the workload for the window; read `ACTIVITYSTMT_*`; drop both on stop | **`MON_GET_PKG_CACHE_STMT`** diff | `SQLADM` or `DBADM` (`EXECUTE` on `MON_GET_*` for Top) | Changes workload settings: record the prior setting and restore it. |
| **ClickHouse** | `system.processes` | **`system.query_log`** (on by default): rows with `event_time` in the window, `type IN ('QueryFinish','ExceptionWhileProcessing')`; `clusterAllReplicas` on a cluster | `query_log` grouped by `normalized_query_hash` | `SELECT` on `system.query_log`; `SYSTEM FLUSH LOGS` to see the last few seconds | The best native source of all the engines; log flush interval is ~7.5 s. |
| **SQLite / DuckDB** | — | — (an embedded file; no server to ask) | DuckDB: `PRAGMA enable_profiling` for Fox's own connection only | — | **Fox activity** is the tracer here. |
| **MongoDB** | `currentOp` | **Database profiler**: `setProfilingLevel(2)` for the window, read `system.profile`, restore the prior level | `system.profile` grouped | `dbAdmin` on the database | Per database, not per server. |
| **Redis** | `CLIENT LIST` | **`SLOWLOG GET`** (commands over `slowlog-log-slower-than`, default 10 ms; lowering it is global) | — | `@admin` / `CONFIG` | **Never `MONITOR`**: it streams every command from every client and costs the server dearly. |

### Architecture

Following the existing utility modules:

- **`@foxschema/sql`** (pure, no I/O): `modules/utilities/sql-trace.types.ts`,
  `sql-trace.registry.ts`, and `providers/<d>/<d>.sql-trace.ts` per dialect.
  Each module declares its `support(mode)` with a hint, and builds:
  - `start()`: statements that create a trace object (empty for history-based engines),
  - `poll(cursor)`: a SELECT for events after a cursor (a timestamp, an event id, or a statistics snapshot),
  - `stop()`: cleanup statements, which must also be safe to run after a crash,
  - `normalize(row)`: map driver rows to one event shape: `{ at, durationMs, user, database, client, sessionId, rows, text, digest, executions, error, source }`.
- **`packages/server/src/features/sql-trace/`**: routes
  `GET /api/trace/support`, `POST /api/trace/start`,
  `GET /api/trace/:id/events?after=`, `POST /api/trace/:id/stop`; a
  `TraceSessionManager` that owns each running trace (owner, connection,
  deadline, cursor, prior settings to restore), stops traces on timeout, on
  owner sign-out and at shutdown, and at boot drops any `fox_trace_*` object a
  crash left behind.
- **Web**: Utilities → **SQL Tracer**, built from shared parts (the virtualized
  `DataGrid`, the connection picker). Controls: connection, mode, filters (user,
  database, application, minimum duration, text contains), Start / Pause /
  Stop, Clear, Export CSV/JSON. Selecting an event shows its full text, with
  **Open in SQL editor** and **Explain**.
- **Fox's own probe queries are excluded**: they carry a `/* fox:trace */`
  comment and an application name, and the trace filters on both, so the
  tracer never shows itself polling.

### Safety

Tracing shows other people's SQL, literals included. That makes it the most
sensitive screen Fox would have.

- **Permission.** A new `utility.trace` permission: **owner and admin** by
  default; not viewer, editor or demo. It covers every mode, Fox activity
  included.
- **Redaction**, server-side, before text leaves the API: values after
  `IDENTIFIED BY`, `PASSWORD`, `WITH PASSWORD`, `SECRET`, connection strings,
  and `AUTH` (Redis). A **Normalized text only** switch (digest text, no
  literals) on by default for Capture.
- **Time box.** At most 15 minutes and 10,000 events per trace, by default;
  then it stops itself. One running Capture per connection.
- **Exact cleanup.** Every global switch it flips (MariaDB `general_log`,
  MySQL consumers, Mongo profiling level, Redis slowlog threshold, Db2 workload
  collection) is recorded at start and restored at stop, on timeout, and at the
  next boot after a crash. XE sessions and event monitors are named
  `fox_trace_*` and dropped by name.
- **Production impact** is stated per mechanism before Start: XE and history
  reads are light; general log and threshold changes are heavy and global.
  Those global switches (MariaDB general log, TiDB slow-log threshold, Redis
  slowlog threshold) are offered, off by default, behind that warning and the
  time box.
- **Logging contract.** Trace text is held in memory for the session and sent
  to the requester only; it is never written to the app log or the metadata
  DB. Saving a trace (later) would be an explicit export.
- **Licensing.** Oracle ASH is never queried, by any mode.
- **The gate.** `start()`/`stop()` statements are DDL or admin commands. They
  run from the trace feature with `utility.trace`, never through
  `/api/sql/execute`, and never with a user-supplied fragment in them.

### Phases and tests

- **Phase 1 — tracer shell on all 14 SQL dialects.** Permission, redaction,
  time box, the Tracer screen, **Live** (from the sessions probes) and
  **Fox activity**. Unit tests for redaction and the session manager (timeout,
  cleanup, one Capture per connection); a guard test that the tracer's text
  never reaches the logger.
- **Phase 2 — history-based engines, read-only.** ClickHouse (`query_log`),
  Redshift (`SYS_QUERY_HISTORY`), TiDB (statements summary), CockroachDB
  (statement statistics, insights), Postgres/Yugabyte (`pg_stat_statements`
  diff), Oracle (`V$SQLSTATS` diff), Db2 (`MON_GET_PKG_CACHE_STMT` diff),
  MySQL (`events_statements_history`). No server objects are created, so no
  cleanup risk.
- **Phase 3 — trace sessions.** SQL Server and Azure SQL XE, Db2 activity
  event monitor, MySQL `history_long` consumer, MariaDB general log, MongoDB
  profiler, Redis slowlog. Each with a crash test: kill the API mid-trace,
  restart, assert the object is gone and the setting restored.
- **Per dialect, an e2e** in `run-all.mjs`: start a capture, run three known
  statements through a second connection, stop, assert all three are listed
  with sensible durations, and that the tracer's own queries are not. Plus a
  "missing privilege" case asserting the remedy text.

---

## Part 3 — Redis: lists and documents as tables

### How it works today

- **Browsing shows nothing.** Redis has no schema provider, so loading its
  schema fails with *"No provider registered for dialect: redis"* and the
  explorer lists no tables. (MongoDB has the same gap; it is a separate
  decision.)
- **Querying maps a key prefix to a table** (`redis.adapter.ts`): `users`
  covers `users:*`, one key is one row. Only two key types become rows: a
  **hash** (its fields are the columns) and a **string** (one `value`
  column). A **list, set, sorted set, stream or JSON document** comes back as
  `{ id, type }` and nothing else, by design: they have "no row shape".
- **JSON documents** are either JSON text in a string key (plain Redis, which
  is what the dev container runs, `redis:7-alpine`) or the JSON type
  (`ReJSON-RL`, from RedisJSON or Redis 8). Neither is opened today.

### Design

**A. A Redis schema provider (read-only, bounded).**

- `SCAN` with `COUNT`, never `KEYS`, sampling at most 10,000 keys, and saying
  "sampled" when the keyspace is larger.
- **Prefix tables**: keys grouped by the part before the first `:`. Columns are
  the union of the fields of up to 50 sampled hashes or JSON documents under
  that prefix, plus `id`. A prefix of plain strings gets `id, value`.
- **Collection tables**: a key holding a list, set, sorted set or stream is a
  table of its own, named by the whole key, listed under its type:

  | Key type | Columns | Row order |
  |---|---|---|
  | list | `index`, `value` | list order |
  | set | `member` | as `SSCAN` returns them |
  | sorted set | `member`, `score` | by score |
  | stream | `entry_id`, then the entry's fields | by id |

  When the elements are JSON objects (a list of JSON payloads is common), their
  top-level fields become columns, as for documents.
- Each table carries a **type badge** in the explorer: HASH, JSON, STRING,
  LIST, SET, ZSET, STREAM.

**B. Rows for every type.**

- **JSON documents**: a `ReJSON-RL` key is read with `JSON.GET`; a string key
  whose value parses as a JSON object is read the same way. Top-level fields
  become columns; nested values show as JSON text. A server without the JSON
  type answers `JSON.GET` with an unknown-command error, which falls back to
  the string path.
- **Collections**: `SELECT * FROM "queue:orders"` reads the elements, paged by
  the command's own range (`LRANGE start stop`, `ZRANGE … WITHSCORES`,
  `XRANGE` with a cursor, `SSCAN`), never the whole collection at once.
- **Resolution rule**: a table name that is itself a list, set, sorted set or
  stream key reads that collection; otherwise it is a prefix, as today. When
  both exist (a list key `orders` and keys `orders:*`), the explorer lists
  them as two tables and a query names which one it means by the type badge's
  table name.

**C. Writes stay where they are, at first.** Hash rows keep INSERT / UPDATE /
DELETE. JSON documents and collections are **read-only** in the first phase,
and say so when a write is attempted. Field updates on a JSON document
(`JSON.SET key $.field`) and list appends are a later phase.

**D. Limits.** Every read is bounded: LIMIT defaults to 100 and is capped at the
editor's 5,000 rows; sampling for columns is capped; no `KEYS`, no
`MONITOR`, no `SMEMBERS` on an unbounded set.

### Tests

- Adapter unit tests with a fake client per key type: hash, string, JSON string,
  `ReJSON-RL`, list (plain and of JSON objects), set, sorted set, stream, and
  the fallback when `JSON.GET` is unknown.
- The live integration test (`redis.it.test.ts`, gated by `FOX_IT_DB=1`) seeds
  one key of each type and reads each back through the SQL subset; run once on
  `redis:7-alpine` (JSON as strings) and once on `redis:8` (JSON type).
- An e2e: the schema explorer lists the prefixes and the collection keys with
  their badges, and selecting a list key shows its elements as rows.

---

## Decisions (2026-10-18)

1. **Compare size: 2,000, fixed.**
2. **Text-key boundary: the conservative rule.** When a side overflows on a text
   key, one-sided rows past the first one are `unresolved`.
3. **Tracer permission: owners and admins**, for every mode including Fox
   activity.
4. **Global switches: offered**, off by default, with the warning and time box.
5. **Oracle ASH: left out.**
6. **Redis lists and documents show as tables** (Part 3).

## Rough size

- Part 1, Phases A–B: about a week, mostly the paged view and the
  cross-dialect fixtures.
- Part 2, Phase 1: about a week. Phase 2: one to two days per engine. Phase 3:
  two to three days per engine, most of it the cleanup and crash tests and
  live verification.
- Part 3: three to four days: the schema provider, the per-type readers, and
  the live tests on two Redis versions.
