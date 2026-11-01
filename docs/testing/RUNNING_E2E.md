# Running the e2e suite

[WRITING_E2E.md](WRITING_E2E.md) covers writing a test. This page covers running
one against real engines, and the failures that come from the machine or the
containers rather than from Fox. Each entry below cost at least one wrong
diagnosis before it was written down.

## Set up

- **A fresh worktree** has no `node_modules` and no `apps/e2e/.env`. Run `npm ci`,
  then copy `.env` from the main checkout. The file holds credentials: copy it,
  never print it or paste it anywhere.
- **Servers.** `npm run dev` starts the API and the web app. When another checkout
  already holds the default ports, use the alternate launch entries: API on
  `:3211`, web on `:5199`. Then point the run at them:

  ```bash
  cd apps/e2e
  E2E_BASE_URL=http://localhost:5199 E2E_API_URL=http://127.0.0.1:3211 \
    npx vitest run --config vitest.config.ts src/tests/<spec>.test.ts
  ```

- **Each worktree's API has its own metadata DB.** The e2e admin may never have
  finished onboarding there. Every page then shows the onboarding screen, and
  tests time out on the first control they look for (for example
  `workspace-rail-btn`). Finish onboarding once with
  `PUT /api/user/preferences {"onboardingCompleted": true}`, using the
  `sessionCookie()` helper.
- **A fresh install** (first-run setup) needs its own API and metadata DB: set
  `APP_DB_PATH` to a scratch file, use another `API_PORT`, and add the web
  origin to `FOX_ALLOWED_ORIGINS`. `sessionCookie()` from
  `apps/e2e/src/helpers/app-session.ts` runs first-run setup. Then call
  `POST /api/signup/skip` and finish onboarding as above.
- **A new spec goes into `apps/e2e/scripts/run-all.mjs`**, or the full run never
  runs it. After adding a `data-testid`, run `npm run test-ids`.

## Containers

- **Start only what the run needs.** This machine cannot run every engine at
  once. With all of them up, CockroachDB stops itself (`disk stall detected`),
  and MySQL and Oracle time out on connect. A run with about five engines up is
  stable. Stop the engines that already passed.

  ```bash
  docker compose -p foxschema -f <main checkout>/docker-compose.yml up -d --no-deps <service>
  ```

  Always pass `-p foxschema` and the main checkout's compose file. From a
  worktree, the folder name would otherwise become the project name, and
  Docker would create new, empty volumes instead of reusing the `foxschema_*`
  ones.
- **Healthy, not just running.** Wait for
  `docker inspect --format '{{.State.Health.Status}}' foxschema-<engine>` to
  say `healthy`. A watch loop's "all healthy" can print while one line still
  says `starting`.
- **Disk.** Check `df -h /System/Volumes/Data` before a dialect run. The engine
  images need tens of GB. Under about 15 GB free, Docker Desktop crashes
  mid-run (containers exit 255 and the socket disappears). With the host disk
  full, its VM disk turns read-only and Postgres answers with
  `Read-only file system`. `docker builder prune` and `docker image prune` free
  space only inside Docker's own disk image, not on the host.
- **Restarting Docker.** Once its disk has gone read-only (every container
  answers `Input/output error`, or `failed to mount … read-only file system`),
  only a restart of Docker's VM clears it. Quitting the Docker Desktop app is
  not enough: its backend and VM keep running and the CLI hangs. Run
  `docker desktop restart`, then start again the containers that were up.
- **Load.** Five dialect failures at load average 30 became 44/44 at 6.7. Check
  `uptime` before believing a failure. Two `vitest` runs next to the browser
  suite cause worker timeouts and collection errors in unrelated files: rerun
  the file alone.
- **Sleep.** On battery, or with the lid closed, the Mac sleeps mid-run, and a
  90-second test "takes" 1,000 seconds. `pmset -g log | grep -E ' Sleep | Wake '`
  confirms it. Keep the machine awake for long runs. A run that spans a
  closed-lid sleep is void: run it again.

## Seed

- **Reseed before every run.** A passing dialect test commits its migration to
  the target, so the next run starts from a changed `demo_b`. Its failures, or
  its empty diffs, look real and are not.

  ```bash
  bash scripts/seed/seed-all.sh <dialect|all>
  bash scripts/seed/reset-all.sh        # compose up, wait healthy, restart dev, reseed all
  ```

- **Restart the API before reseeding Oracle or Db2.** The API keeps pooled
  sessions open. Oracle's `DROP USER … CASCADE` does nothing against an active
  session (the seed ignores the error), so the reseed runs against the old
  schema.
- **Seed exit codes lie.** `seed-all.sh` reports Db2 as not seeded on the
  harmless `SQL0605W` (the index already exists), and sometimes reports
  CockroachDB or YugabyteDB the same way on NOTICE output. Check the end state
  instead: `SYSCAT.TABLES` on Db2, `information_schema.schemata` on the
  Postgres family. One `ORA-01408 such column list already indexed` on Oracle
  is expected.
- **Db2's first boot is slow** (2–4 minutes). Its image has no
  `docker-entrypoint-initdb.d`: a wrapper script in `/var/custom` runs the SQL
  mounted at `/var/custom-sql/`.

## Failures that are not bugs

| Symptom | Cause | Fix |
|---|---|---|
| A test passes alone (`-t <dialect>`) but fails in a full run | A per-user rate limit: `/schema/db-access` 20/min, `/sql/execute` 60/min, snapshot capture 20/min. Every suite signs in as the same user | `clickRateLimited` in `helpers/rate-limited.ts`. Don't raise the limits |
| Db2 database-access drop or edit test fails on `DROP ROLE "newrole"` | A role an earlier run left behind sorts first, and the test takes the first row | `docker exec foxschema-db2 su - db2inst1 -c 'db2 connect to foxdb > /dev/null && db2 "DROP ROLE \"newrole\""'`. The name is lowercase, so quote it |
| Oracle: "seeded role FOX_READER is not listed" | The e2e Oracle account cannot read the data dictionary, so the probe falls back from `DBA_ROLES` to `ALL_USERS` | A seed grant (`SELECT_CATALOG_ROLE`), still to do |
| Oracle DDL fails with `ORA-01804` | A newer Oracle image is running against a volume created by an older one, with a different timezone file version. Compare `DST_PRIMARY_TT_VERSION` in `database_properties` with `$ORACLE_HOME/oracore/zoneinfo` | Recreate the Oracle volume and reseed, or pin the older image. Recreating deletes the volume: ask first |
| YugabyteDB never becomes healthy and seeding hangs | The single node waits for masters at its old IP addresses (see `yugabyted.log`) | Recreate the container with a fresh volume. That deletes its data: ask first |
| MongoDB live tests fail with "driver mongodb is not installed" | The driver is an optional dependency | `npm install mongodb --no-save` in the checkout the API runs from. Run the live tests with `FOX_MONGO_URL='mongodb://foxroot:FoxPass123@127.0.0.1:27017/?authSource=admin'` |
| Every request returns 502 mid-run | The API process exited. Check its log for the stack. An idle `pg` pool error once did this; `pool-error-guard.ts` stops it now, so don't remove those handlers | Restart the API |
| Pages time out for a few seconds mid-run | A file changed in the worktree the servers run from. `tsx watch` restarted the API (its log says `Restarting...`), and Vite reloaded open pages | Do A/B edits in another worktree, or wait for the run to finish |
| SQLite: "attempt to write a readonly database" | The API pools SQLite handles by path. A spec that deletes and reuses one path writes through a stale handle | A per-run directory (`Date.now().toString(36)`) |
| Editor text read from the page is missing its end | Monaco renders only the visible lines | `SqlEditorPage.editorText()` reads the saved tab |
| Results checked before they arrive | The results container mounts before its rows | Wait for the last `sql-results-running` spinner to go |
| A multi-statement script runs only its last statement | With nothing selected, Run runs the statement at the caret | Select all first. Load long text with `keyboard.insertText` |
| `turbo build` changes `AGENTS.md` | Turbo adds agent rules when it detects an agent | `git checkout -- AGENTS.md` before committing |

## Containers that make a pass meaningless

These containers let a check pass for the wrong reason. Run every such probe
with a wrong password first, and check that it fails.

- **PostgreSQL trusts loopback logins.** A wrong password still connects from
  `127.0.0.1`. Probe from another container against the Postgres container's
  IP instead.
- **MongoDB needs auth on.** Without `MONGO_INITDB_ROOT_*`, a `read` user can
  write. `docker-compose.yml` sets them; keep them.
- **A failed Redis `AUTH` keeps the connection** as `default`, which can do
  everything here. Check `ACL WHOAMI` on the same connection.
- **Db2's CLP exits 1 on a SELECT with no rows**, which is often the right
  answer (a revoked grant, a dropped user).
- **Oracle keeps a quoted user name lowercase.** Log in as
  `'"fox_x"/"pw"@//host:1521/FREEPDB1'`, not `fox_x/pw`.
- **MySQL error codes tell the failures apart.** Error 1045 means the password
  failed. Error 1044 means the password worked and the grant did not.
- **MariaDB 11.8 has no `mysql` client**, only `mariadb`.

## Before calling something a regression

The control run must come from before the change. Comparing a branch with an
`origin/main` that already holds the same PR only shows that identical code
fails the same way. Check `gh pr view <n> --json mergedAt` against the fetch
time, and use `<merge commit>^` when in doubt.
