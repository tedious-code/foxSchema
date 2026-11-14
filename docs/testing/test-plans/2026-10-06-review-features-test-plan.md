# Test plan: review features across every engine (2026-10-06)

What shipped in tedious-code/foxSchema#481, #483 and #484 (bundle and loading,
Access Grants as one view, routine grants, backups run and listed) is covered
today by unit and component tests and by the dev-server e2e suites that need no
database. None of the new SQL has run against a real server: the local Docker
VM went read-only (host disk full). This plan says what to add and where, so
"works on every engine" is a claim a test makes rather than one a reviewer
infers.

## Layers and what each can prove

| Layer | Runs | Proves | Gate |
| --- | --- | --- | --- |
| Unit (`packages/sql`) | everywhere, every PR | the SQL text each engine gets, quoting, refusals, row normalisation | default `vitest run` |
| Component (`web-ui`) | everywhere, every PR | the screens: one Grants view, run/confirm/list/pick in Backup | default `vitest run` |
| Live (`FOX_IT_DB=1`) | with `docker compose up -d` | the server accepts the SQL and the catalog reads return what was granted | `FOX_IT_DB=1`, per-engine skip when a container is down |
| E2E (`apps/e2e`) | dev servers + containers | the whole path in a browser, per configured engine | `.env` credentials, `hasConfig(dialect)` |

A skipped engine must say why in the test name or a `skip` reason. A skip that
reports as a pass (the Db2 `SELECT 1` probe of `generated-ddl-live.test.ts`) is
the failure this plan exists to prevent.

## Engines

Grant-capable (Access): postgres, yugabytedb, cockroachdb, redshift, mysql,
mariadb, tidb, sqlserver, azuresql, oracle, db2, clickhouse.
No grants: sqlite, duckdb (file permissions), redis, mongodb (non-SQL ACLs).
Backup runs on the server as SQL: sqlserver, cockroachdb, clickhouse, duckdb.
Backup history recorded: sqlserver (msdb), db2 (DB_HISTORY), clickhouse (system.backups).
No container locally: azuresql (cloud only); redshift is an emulator.

## 1. Unit: one matrix per feature, every engine (`packages/sql`)

New file `modules/access/routine-privileges.matrix.test.ts`:

- For every grant-capable family, the privilege query ladder reads routine
  grants or the test names why it cannot (sqlserver and oracle read them through
  `database_permissions` / `DBA_TAB_PRIVS` already; clickhouse has no routines).
- For every family, `buildGrantRevokeSql` for `PROCEDURE`, `FUNCTION`, `ROUTINE`:
  the exact clause (`ON PROCEDURE`, `ON FUNCTION`, `ON ROUTINE`, `ON OBJECT::`,
  Oracle with no keyword) or a refusal with a sentence, never a TABLE clause.
- `normalizeDbPrivileges` keeps the routine kind for every spelling the engines
  return (`PROCEDURE`, `FUNCTION`, `ROUTINE`, Db2 `P`/`F` via the CASE).
- `splitHeldPrivileges`: for each object type, held vs elsewhere; DENY always
  elsewhere; `describeHeldPrivilege` reads naturally for each type.

New file `modules/utilities/backup-history.matrix.test.ts`:

- Every engine in `backupSupport`: `history` is present exactly for sqlserver,
  db2, clickhouse; the query classifies as `read` (`sqlStatementCategories`),
  so `/sql/execute` runs it with `editor.run`.
- Every engine: a `restoreFrom` it cannot read leaves the restore identical to
  the one without it (table-driven, including injection attempts:
  `'; DROP`, `Disk('a') ; DROP`, a 13- and 15-digit Db2 timestamp).
- Every server-side SQL engine's backup classifies as `ddl`, so running it
  needs `editor.ddl` (documents the permission the panel checks).

New file `modules/capabilities/schema-compare.matrix.test.ts`:

- For every key in `PROVIDER_SETTINGS` and some unknown names,
  `schemaCompareSupport` equals `dialectFeatures(…).schemaCompare`, reason text
  included.

## 2. Component: the screens (`web-ui`)

- `AccessGrantsStage`, per grant-capable dialect (mocked catalog): opens with no
  mode switch; also-holds line lists database and schema grants; the General
  section is present and the object sections are not; a routine row with a
  held EXECUTE opens ticked.
- `BackupRestorePanel`, per dialect: run offered exactly where
  `runsOn === 'server'` and the backup is SQL; history offered exactly where
  `history` exists; a password-needing connection without a session password
  disables both with the reason; a failed run shows the server's message; a
  failed history read shows it too; picking then "Restore the newest instead"
  restores the default command.

## 3. Live: the servers accept it (`FOX_IT_DB=1`)

New file `packages/server/src/features/access/access-live.test.ts`, one
`describe` per engine, skipped by name when its container does not answer the
engine's own probe (`SELECT 1 FROM SYSIBM.SYSDUMMY1` on Db2, `FROM DUAL` on
Oracle):

1. Create a throwaway role or user, a table and a function (and a procedure
   where the engine has them), tagged with the run id.
2. Grant: SELECT on the table, EXECUTE on the routine, and the engine's
   database- or schema-wide privilege (CONNECT, USAGE, CREATE).
3. Run `buildDbAccessPrivilegeQueries` through the ladder as the app does;
   normalise; filter to the principal.
4. Assert the table grant and the routine grant (with its kind) are there;
   `splitHeldPrivileges` with the real catalog puts both on grid cells and the
   wide grant in `elsewhere`.
5. Revoke the routine grant with `buildGrantRevokeSql` and run it: the server
   accepts it, and a re-read no longer lists it. On Oracle, revoke a table
   grant too (the `ON TABLE` fix).
6. Drop everything in `afterAll`, even after a failure.

Engines: postgres, yugabytedb, cockroachdb, mysql, mariadb, tidb, sqlserver,
oracle, db2, clickhouse (no routine step). Redshift: table and schema only.

New file `packages/server/src/features/backup/backup-live.test.ts`:

- sqlserver: run `buildBackupCommands().backup`; run `backupHistoryQuery`; the
  new file is the first row; restore with `restoreFrom` = that key using
  `RESTORE VERIFYONLY` (never a real restore over the database).
- db2: `BACKUP DATABASE` through the CLP in the container (`docker exec`), then
  the history query lists it; the restore text carries `TAKEN AT <that>`.
- clickhouse: skip with the reason unless the server allows a backup disk
  (`<backups><allowed_disk>`); when allowed, back up, list, restore under
  `_restored`, drop it.
- duckdb: `EXPORT DATABASE` to a temp folder and `IMPORT DATABASE` into a fresh
  file; compare table counts.
- cockroachdb: `BACKUP INTO` a `nodelocal` collection, `RESTORE … new_db_name`,
  drop the restored database.

## 4. E2E: the whole path (`apps/e2e`)

- `access-assistant-dialects.test.ts`, per configured engine: Grants opens on the
  seeded principal with no mode switch; the also-holds line is present when the
  seed grants something database-wide; a seeded function grant opens ticked.
  Seeds gain one function and one EXECUTE grant per engine (`scripts/seed`).
- `backup-restore-ui.test.ts`: sqlserver run → confirm → "Backup finished" →
  list → pick → restore text names that file. Postgres: no server actions.
- `lazy-loading.test.ts` (exists): keep; add the Workflow cron preview reaching
  real fire times, and Compare on one SQL engine reaching a generated script
  (the generator now loads with the comparison).

## Coverage targets

- Every engine named in a matrix test, with a reason when it is excluded.
- Live: every engine with a container either passes or is skipped by name; CI
  stays DB-free (the live and e2e layers run on demand and before a release).
- Bundle: first visit stays under the 170 KB gzip budget (CI, every PR).

## Gaps this closes

- New catalog SQL (routine grants on three engines, history on three) never ran
  against a server.
- The Oracle `ON TABLE` fix is untested against Oracle.
- No test proves a picked backup's key round-trips from the server's own history
  into a restore the server accepts.
- E2E seeds have no routines, so no browser test can show a routine row ticked.
