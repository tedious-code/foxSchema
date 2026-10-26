# Test and fix pass: results (2026-10-25 to 2026-10-26)

The first round of the [test and fix plan](2026-10-25-feature-and-dialect-test-plan.md).
The planning board holds the live state, one card per feature and per engine.
This page is the snapshot at the end of the round, so it can be read without the
board.

**Short version:** the automated suites are green on every engine except Oracle
and MongoDB, and both of those are blocked by the environment, not by Fox. No
feature has had its manual walk yet. Fixes found during the round shipped with
A/B tests in #546 and #550 to #564.

## Engines

All of them ran their `dialects/<engine>` e2e suite (11 tests each), unless the
note says otherwise.

| Engine | Result | Notes |
|---|---|---|
| PostgreSQL | Pass | Plus compare-flow, execute-gate, schema-browse, history, revert, revert edges, compare-multi-target and the access suites |
| CockroachDB | Pass (10-26) | Utilities 4/4, database access 9/9, access assistant 4/4. The backup suite has no CockroachDB case |
| YugabyteDB | Pass (10-26) | Utilities 4/4, database access 9/9, access assistant 4/4 |
| Redshift | Pass | Against a local Postgres stand-in. Utilities 4/4 |
| MySQL | Pass | Access, accounts, backup and utilities suites as well |
| MariaDB | Pass | Utilities 4/4 |
| TiDB | Pass (10-26) | Utilities 4/4 including clone, database access 9/9, access assistant 4/4 |
| SQL Server | Pass | Access (with DENY), accounts, backup and utilities suites as well |
| Azure SQL | Pass | Against the SQL Server container |
| Db2 | Pass (10-26) | Utilities 4/4, database access 9/9, access assistant 4/4, after clearing the leftover `newrole` role ([runbook](../testing/RUNNING_E2E.md#failures-that-are-not-bugs)) |
| SQLite | Pass | Most feature suites run on SQLite too |
| DuckDB | Pass | |
| ClickHouse | Pass | Utilities 4/4 |
| Redis | Pass | redis-editor e2e 21/21, live `redis.it.test` 19/19 |
| Oracle | Blocked | The re-pulled image is a newer build than the one that created the data volume, so DDL fails with `ORA-01804`. Needs the volume recreated and reseeded, or the older image pinned |
| MongoDB | Blocked | The container runs. The live tests need the optional `mongodb` driver, which is not installed. There is no MongoDB e2e spec |

The manual walk is still to do on every engine.

## Features

"Partial" means the automated suites passed and the manual walk is left.

| Feature | Result | Manual walk left |
|---|---|---|
| `editor.run` | Partial | Shortcuts, Format SQL+JS, completions, column picker |
| `editor.datacompare` | Partial | Sync column, backup snapshot on apply, Preview SQL |
| `schema.compare` | Partial | Diff briefing, cross-dialect readiness, streamed progress |
| `schema.snapshots` | Partial | Graph, change chart, rename a version |
| `access.builder` | Partial | Object picker, stop at the first failure |
| `access.accounts` | Partial | By hand on each engine with accounts |
| `platform.auth` | Partial | SSO with real Google, Microsoft and GitHub apps; launch from `foxschema open`; email verification with real mail |
| `platform.workspaces` | Partial | Declining an invite, 14-day expiry, shared scripts |
| `platform.connections` | Partial | Windows and LDAP forms, SSL and pool options, cloud credentials, Install driver |
| `editor.code` | Partial | TypeScript cells, imports, Server Beam |
| `editor.results` | Partial | Column reorder, fullscreen |
| `editor.peek` | Pass | Date picker, generators |
| `editor.explorer` | Partial | Object source script, Install driver banner |
| `editor.library` | Partial | Bookmarks, samples, variables, secrets panels |
| `editor.files` | Partial | No e2e yet. CSV and Excel import into SQLite and a saved connection |
| `schema.applies` | Partial | The Applies list and rerun |
| `schema.git` | Pass | |
| `utilities.backup` | Pass | |
| `utilities.clone`, `.indexes`, `.insights`, `.dbaccess` | Partial | Green on every engine that ran |
| `utilities.trace` | New (#564) | SQL Tracer: e2e 2/2 (SQLite Fox activity, Postgres live) |
| `platform.admin` | Partial | Handing over admin, editing the role matrix |
| `platform.secrets` | Partial | No e2e yet. Vault entries, cloud providers, resolve |
| `platform.system` | Pass | |
| `access.inspector`, `access.report` | Partial | Report export. Oracle's FOX_READER case waits on Oracle |
| `workflow.designer` | Pass | |
| `workflow.engine`, `.pipes`, `.runs` | Partial | Engine settings and sinks; run history and retry |
| `cli` | Partial | `foxschema open`, shortcut, TUI |

## Fixed during the round

| PR | What |
|---|---|
| #546 | Run rail and Install driver follow-ups (15 review findings) |
| #550 | P0: sharing a personal workspace could lend more than the sharer holds. Restore archived workspaces |
| #552 | Redis keys as tables. A short `SELECT …;` was rewritten into broken SQL. Data peek WHERE on Redis and MongoDB |
| #553 | Data peek grid hidden by its filter rows |
| #554 | Demo role and demo mode |
| #555 | Emailed invite and reset links landed on sign-in |
| #557 | Redis and MongoDB offer No password as a login method |
| #558 | Force-migrate e2e |
| #559, #560 | Data Compare at 2,000 rows, one shared 2,000-op migrate cap |
| #561 | Read-only is a permission (`app.write`) |
| #564 | SQL Tracer |

## Still open

- **Oracle and MongoDB passes:** blocked as above.
- **Oracle FOX_READER:** the e2e account needs a dictionary grant in the seed (P3).
- **Code-cell timeout test:** flaky under load, because the 4 s budget includes
  the worker's cold start (P3).
- **Opening a sample bookmark** unchecks every Destination (P3).
- **The workflow SQL step** warns about a missing password on SQLite and on Redis
  without a password (P3).
- **Four e2e specs** still define their own `api()` helper instead of using
  `helpers/accounts.ts` (P3).
- **Every manual walk** above. Four of them have their own cards on the board:
  run rail (scheduled), compare and deploy, Redis in the editor, workspaces.
- **Later phases:** Data Compare across whole tables by key range; engine-native
  profilers for the SQL Tracer.
