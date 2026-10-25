# Test and fix plan: every feature, every dialect (2026-10-25)

Every feature in [FEATURE_MAP.md](../FEATURE_MAP.md) and every one of the 16
engines gets one **test-and-fix pass**, tracked as a work item on the planning
board (kind *test*, one item per feature ID and per `dialect.*` ID). Bugs a pass
finds become their own *bug* items, linked from the pass.

## What a pass is

A pass is done when all five hold:

1. **Automated suites green.** The unit and e2e specs in the feature's catalog
   row (the **Tests** column) pass. For a dialect, its `dialects/<engine>`
   e2e suite and the provider unit tests pass, plus the live `*.it.test.ts`
   with `FOX_IT_DB=1` where one exists.
2. **Manual walk.** Each sub-feature, in the order the catalog lists them, on a
   real database. Results are recorded in the item's *Manual test* fields: date,
   pass / partial / fail, and notes.
3. **Every defect filed.** One *bug* item per defect, priority by impact
   (P0 data loss or security, P1 a feature broken, P2 normal, P3 cosmetic).
4. **Every fix tested first.** A test that fails without the fix and passes with
   it (A/B), then the fix. No fix without the test that would have caught it.
5. **Docs follow.** User-visible behaviour that changed is reflected in
   `docs/user-guide.md`; a dialect gotcha goes into
   `packages/sql/src/providers/DIALECTS.md`.

## Order

Highest risk first: the features that write to someone's database or decide
who may.

| Wave | Features | Why first |
|---|---|---|
| 1 | `editor.run`, `editor.datacompare`, `schema.compare`, `schema.snapshots`, `access.builder`, `access.accounts`, `platform.auth`, `platform.workspaces`, `platform.connections` | They write to target databases, change grants, or decide access |
| 2 | `editor.code`, `editor.results`, `editor.peek`, `editor.explorer`, `editor.library`, `editor.files`, `schema.applies`, `schema.git`, `utilities.*` | Daily editor and schema work |
| 3 | `platform.admin`, `platform.secrets`, `platform.system`, `access.inspector`, `access.report`, `workflow.*`, `cli`, `engines.dialects` | Read-mostly or administrative |

Dialects go by family, so one fix is checked across its relatives at once:

| Wave | Engines | Shared risk |
|---|---|---|
| D1 | PostgreSQL, CockroachDB, YugabyteDB, Redshift | Postgres grammar; CockroachDB auto-commits DDL; Redshift clears a password on rename |
| D2 | MySQL, MariaDB, TiDB | DDL auto-commits; executable comments carry writes; case-sensitive names on Linux |
| D3 | SQL Server, Azure SQL | T-SQL paging (OFFSET / FETCH); a dropped user leaves its login; Azure TLS verification |
| D4 | Oracle, Db2 | Name folding and quoting; Db2 REORG through ADMIN_CMD; ibm_db native build |
| D5 | SQLite, DuckDB, ClickHouse | Files without grants; limited ALTER; ClickHouse without row editing or transactions |
| D6 | Redis, MongoDB | The fail-closed SQL subset; keys as tables (Redis) |

## A dialect pass

The checklist on each `dialect.*` card follows from what the engine supports
(`dialectFeatures()`), so a pass never tests what the engine cannot do and never
skips what it can:

- connect, test, browse the schema; driver check and Install driver
- compare two schemas, generate and run migration DDL, snapshot capture and revert *(engines with schema compare)*
- run SQL with writes classified for the dialect (Redis and MongoDB: the subset), results paging
- row editing and data peek *(engines with row editing)*
- data compare and migrate between two databases
- access: inspect, GRANT / REVOKE; database accounts *(engines with DB access / user management)*
- One transaction rolls back, or is refused with its reason
- backup command builder; index fragmentation and maintenance SQL *(SQL engines)*

## Environment

- `docker compose up -d <service>` for the engine, then seed it; reseed before
  every e2e run.
- Containers that make a passing test meaningless: Postgres trusts every login,
  MongoDB runs with auth off, Redis falls back to no AUTH, the Db2 init exits 1
  while still serving, YugabyteDB can stick on a stale master list.
- E2E groups: `apps/e2e/scripts/run-all.mjs` (`npm run test:e2e:all`, or one
  group by key). Live driver tests: `FOX_IT_DB=1 npx vitest run <file>`.
- Keep the machine awake for long runs: a sleeping laptop stretches timers and
  fails tests that are not broken.

## Cadence

One feature wave and one or two dialect waves per sprint. A change to
`packages/sql/src/providers/<engine>` re-opens that engine's pass. The board's
*Manual tests* view shows each feature's last run and the next one scheduled.
