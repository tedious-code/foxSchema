# Fox Schema — User Guide

Fox Schema compares two databases and shows you exactly what's different, then writes the
SQL to make one match the other. This guide is for **using** Fox Schema — no coding required.

- [What Fox Schema is for](#what-fox-schema-is-for)
- [Install & run](#install--run)
- [Updates](#updates)
- [First run](#first-run)
- [Connect a database](#connect-a-database)
- [Run a comparison](#run-a-comparison)
- [Read the diff](#read-the-diff)
- [Generate & apply a migration](#generate--apply-a-migration)
- [SQL Editor](#sql-editor)
- [Utilities](#utilities)
- [Workflow](#workflow)
- [Access control](#access-control)
- [Snapshots](#snapshots-schema-history)
- [Applies](#applies-migration-runs)
- [Troubleshooting](#troubleshooting)

## What Fox Schema is for

Typical uses:

- **"Is staging the same as production?"** — compare the two and get a list of every
  difference.
- **"Bring dev up to date with the new schema."** — generate the migration SQL and apply it.
- **"What changed between these two databases?"** — a clear, grouped, searchable diff.

Fox Schema never changes your **source** database. It only ever writes to the **target**, and
only when you explicitly apply a migration.

## Install & run

**Option A — CLI (recommended on your laptop).** Install, then open the local UI:

```bash
npm install -g foxschema
# or Homebrew:
# brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
# brew trust tedious-code/foxschema && brew install foxschema
foxschema                         # http://localhost:3210
foxschema shortcut                # optional Fox icon on your Desktop
```

Full install matrix (npm, Homebrew, Winget, Docker, curl/wget): [INSTALL.md](INSTALL.md).

**Option B — Docker (shared/team server):**

```bash
docker pull 5nickels/foxschema:latest
docker run -d --name foxschema -p 3210:3210 -v foxschema_data:/data 5nickels/foxschema:latest
```

Open **http://localhost:3210**. Details: [DEPLOYMENT.md](DEPLOYMENT.md).

## Updates

Fox Schema checks npm for a newer `foxschema` version when you open the UI.

1. An **Update available** toast appears (and a badge on the profile menu).
2. **What's new** opens the [GitHub Release](https://github.com/tedious-code/foxschema/releases)
   page for that version (ship notes from `docs/releases/RELEASE_*.md`).
3. **Update now** (local npm CLI installs only) installs the latest package and
   restarts the UI — **no terminal**, no `npm update -g foxschema` by hand.
   You can also use **User Preference → Update now**.

Docker / Homebrew / locked-down servers get **Copy command** (or use
`brew upgrade foxschema` / `docker pull …:latest` — see [INSTALL.md](INSTALL.md)).

## First run

Every install asks you to **sign in**. The first time, the page is **Create
your account** — the first account on this install is its administrator
(email and password). From another machine — including through a reverse
proxy — setup also asks for a one-time code printed in the server log
(`docker logs <container>` on Docker). After that, only an administrator can
add people; there is no self-registration.

After you sign in, Fox Schema may show a short **welcome wizard** asking for
your email so you can get product updates (new dialects, releases). It is
optional — use **Skip for now** if you prefer. It only appears once per install.

You land on **Home**: continue last compare / last query, **Snapshots**, **Utilities**,
and saved connections (grouped by dialect). **⌘K** / **Ctrl+K** searches workspaces and
recents. The left rail is **Compare**, **Editor**, **Utils**, **Access**, **Workflow**,
**Snapshots**, then **Creds** and **Applies** at the bottom.

Fox also sets up an **encryption key** that protects the database passwords you save.
The CLI creates one under your user data directory; Docker auto-generates one on the
`/data` volume (or use `APP_ENCRYPTION_KEY` in `.env`).

> Keep that key stable. If it changes, previously saved passwords can no longer be
> read and you'll need to re-enter them.

## Connect a database

1. Click **Creds** on the left rail (or a connection chip → new).
2. Pick the **type**. Saved credentials are **grouped by dialect**; search by name.
   PostgreSQL, MySQL, MariaDB, SQL Server, Azure SQL, Oracle, Db2, SQLite, DuckDB,
   ClickHouse, Redshift, CockroachDB, YugabyteDB, and TiDB are first-class SQL.
   MongoDB and Redis appear in the list (settings only — no schema compare).
3. Fill in host, port, database, username, and password. Schema is optional on
   PostgreSQL (the form matches the engine). SQLite and DuckDB are **file paths**
   — use **Browse…**; they have no password.
4. **Test** the connection, then save it. Passwords are encrypted — they're stored
   safely and never shown back to your browser.

Do this for both the database you're comparing **from** (Original) and the one you're
comparing **to** (Target).

## Run a comparison

1. On the left rail, open **Compare**.
2. Choose an **Original Server** connection and a **Target** connection.
3. Click **Compare**.

A **Same DB** warning appears only after **both** sides are picked and they name the
same database and schema. Two empty chips are not “the same database”.

Fox Schema reads both schemas and builds the diff. You can narrow what it looks at (tables
only, views, functions, etc.) with the scope filter.

## Read the diff

Results are grouped by object type with a summary at the top:

- **+ Added** (green) — exists in source, missing in target.
- **~ Modified** (yellow) — exists in both but differs.
- **− Removed** (red) — exists in target, not in source.
- **= Unchanged** (dim) — identical.

Click any object to drill in and see the exact column, index, foreign-key, and
trigger differences. Use the search box to jump to a specific name.

**Comparing two different database types?** (e.g. Postgres → MySQL) Fox is
cross-dialect aware: equivalent types aren't flagged as changes, and a readiness
panel tells you up front which object types translate cleanly and which need a manual
look (view/function bodies, for instance, aren't auto-translated).

## Generate & apply a migration

1. From the diff, choose **Generate migration** (or the DDL view).
2. Review the SQL — it targets the **target** database's dialect. Nothing has been
   applied yet.
3. To apply it, choose **Deploy / Migrate**. You'll get a confirmation and a
   pre-migration snapshot is taken first.
4. **Skip failures (optional):** turn this on and Fox continues past any single object
   that fails, instead of rolling back the whole run — useful for large migrations
   where you want to apply what you can and fix the rest afterward. The result then
   shows "completed with failures" and lists what was skipped.

You can always just copy the generated SQL and run it yourself instead of applying it
through Fox Schema.

### Commit the migration to Git first

When an admin has added a Git repository (**Access control → Git**), Migrate shows
**Commit to Git** next to Execute:

1. Choose the repository and a branch — or **New branch…**, which starts from the
   repository's default branch.
2. Write a **note**. It becomes the commit message, so say what the migration does
   and why.
3. Review the **file** Fox will add — `migrations/20261002-153012__your-note.sql`.
   It is plain SQL anyone can read and run; the plan's steps are kept in comments
   so Fox can run exactly those steps later. Passwords in account statements are
   replaced with `<password>` and never reach the repository. If Fox cannot read
   how a password is written, it refuses the commit and names the line; put
   `<password>` there yourself.
4. **Commit**, or **Commit & push** to send it to the remote for review.

Execute then says **Execute committed abc1234** and runs the migration *from that
commit*: the database gets exactly what was committed. Change the selection after
committing and the commit no longer describes the plan, so Execute goes back to
the plan on screen. An admin can make a repository **require a commit**; then
nothing runs until the plan is committed, and schema history **revert** and
**force-migrate** are turned off, since they change the schema the same way.
Statements run in the SQL editor or by workflows are not covered.

### Migrations from your team

**Applies → Git** shows a repository's branch:

- **Fetch** gets the remote's branches and shows how far behind or ahead you are.
- **Pull** brings the branch up to date. If both sides changed it, Fox makes a merge
  commit; if the same file changed on both sides it stops and changes nothing.
- **Push** sends your commits. If the remote moved on, pull first.
- Each migration on the branch is marked **Applied** to the target you are connected
  to, or **Incoming** — not yet run there. **Review** shows the file; **Run**
  applies an incoming migration from its commit, through the same confirmation and
  progress view as Execute.

Fox remembers what ran against which database for good, so an old migration never
shows up as incoming again.

**Activity** next to a repository in **Access control → Git** shows admins who
added or changed it (a replaced token is noted, never shown), created branches,
committed, pushed and pulled. Everyone pushes with the repository's one token,
so this is the record of who acted. **Who can see it** limits a repository to
some app roles: for everyone else it does not exist, in the lists and when a
migration from it is run. Admins see every repository.

## SQL Editor

Use the **SQL Editor** to run ad-hoc queries and inspect data (separate from schema
compare / migrate). It lives in the same local web UI you open with `foxschema`.

1. Open Fox Schema (`foxschema` or the Desktop shortcut).
2. On the left rail, click **Editor** (next to **Compare**).
3. Under **Destinations**, check one or more saved connections — the same SQL runs
   against every checked server (handy for comparing data across environments).
4. Type SQL in the editor. Multiple statements are fine; use the **statement strip**
   under the editor to enable/disable individual statements before Run. Or **select**
   a statement (or any SQL) in the editor — Run becomes **Run selection** and only
   that text is executed (variables still expand).
5. Click **Run**. Results appear below, grouped by connection (stack or side-by-side).

6. **Compare data across servers** — switch the results layout to **Side-by-side**
   and check two or more Destinations. **Compare data** is off by default so grids
   stay plain until you turn it on. Rows then **line up by key columns** (PK / your
   **Keys** checkboxes in Data migrate — same set for Compare and migrate), so
   matching IDs share a row instead of comparing by ORDER BY index. Differing cells
   are colored: amber (modified), rose (missing / only in original), emerald (extra /
   only in dest). Pick **Original server** (and **Destination** when more than two).
   **Skip trigger cols** (on by default) ignores audit fields such as `createdAt` /
   `updatedBy`. The destination grid shows a **Sync** column (on by default for all
   differing rows) so you can include or exclude individual rows before migrate.
   On a **partial** page (not page 1, a next page exists, or the result was
   truncated), rows that appear only on the other side stay **unresolved** — they
   are not colored as missing/extra, because they may simply be on another page.

7. **Data migrate (≤500 row ops)** — with Compare on, **Data migrate** appears.
   Rows match by the **Keys** you check (PK/unique columns are marked; you can pick
   any shared column, e.g. compare by name only — name Keys are fine for alignment
   and **Add-only** migrate). **Edit** and **Delete** require the table’s unique
   key (primary key, or a non-partial unique index) to be **in the SELECT and
   checked** — otherwise a name column would UPDATE/DELETE every matching row on
   the destination, including rows you never saw. **Sync all** re-checks every
   differing row without changing your Add / Edit / Delete choices. Migrate only runs
   when **both** grids show the **full** result on **page 1** (no next page) —
   otherwise “missing on this page” is not “missing from the table” and Delete could
   remove real destination rows. You choose **Add / Edit / Delete** (none selected
   until you check them); only rows still checked in **Sync** are applied. Safety
   assists: **Transaction** (all-or-nothing when Stop is on) and **Stop on error** /
   **Continue on error**. Optional **Include identity / IDs**. With **Skip trigger
   cols**, migrate does not treat audit columns as edits and omits them from
   INSERT/UPDATE so destination triggers can fill them. Progress lists each row;
   failures show the key and error. Fox snapshots affected destination rows and
   records the run under **Data migrate history**. More than 500 ops shows a toast
   with Server Beam instructions instead of applying.

Tips:

- **Tabs** — open several buffers; rename with double-click. SQL text is remembered
  locally; result grids are not.
- **Schema explorer** — browse objects on the left; click a name to insert it at the
  cursor. Autocomplete uses the checked connections’ schemas when available.
  Type a schema name then `.` (`demo_a.`) to list that schema’s tables; in
  `FROM` / `JOIN` the insert is `table alias` so you can qualify columns with the
  short name. In the SELECT list, `schema.` inserts the bare table (no alias).
  `table.` and `alias.` still suggest columns. A name that is both a schema and
  a table keeps its **columns** (`orders.`). An unknown qualifier shows a short
  explanation instead of an empty popup.
  **Edit table** shows each index’s fragmentation % for every dialect (physical or
  estimated probe; SQLite / DuckDB / ClickHouse / Redshift list indexes when no
  native % exists). Paste custom SELECT if the default fails, and use the wrench
  to insert rebuild/reorg/optimize/REINDEX SQL when useful. The index form opens
  under the selected index (no jump to a form at the bottom of the section).
  Index Management, Clone Table, and Query files live in **Utils** — see
  [Utilities](#utilities).
- **Data peek** — two ways in:
  - **Schema:** hold **Cmd** (macOS) or **Ctrl** (Windows/Linux) and click a
    table, view or MQT to see its rows without writing a query.
  - **Results:** after Run, foreign-key cells are underlined in rust — click one
    to open the related parent rows in Data Peek.
  In the peek window you can follow more FKs (panels stack and scroll), edit
  WHERE / ORDER BY / LIMIT (filters auto-apply when you edit, blur, or press Enter; Apply still works), use Prev/Next, drag ⋮⋮ to rearrange, and resize.
  **Esc** closes. Values are bind parameters.

  **Add / Edit / Clone row** — when you have **Change data** plus the matching
  **Data grid** permission (**Insert** / **Update** / **Delete**), peek and
  single-table result grids show row actions. Viewers stay read-only. The form:

  - Sparkles **Generate** fills a field (or all editable fields) from a curated
    list (person, location, number, date…). English faker loads on first use;
    a local fallback list works before that chunk arrives.
  - Number fields accept a simple `=` formula on blur: digits, `.`, `+`, `-`,
    `*`, `/`, and parentheses only (`=10+5`, `=100*1.1`). No function names.
  - Date / timestamp fields have a calendar; you can still type the catalog format.
  - Edit mode: pick which columns go in `SET` (All / None; typing a field selects it).
    Identity columns, and primary keys while editing, stay locked.
  - **Preview** shows the SQL (and an edit diff) before **Save**. Safe mode still
    confirms UPDATE / DELETE after Preview.

  Catalog checks (NOT NULL, ranges, UUID, JSON, length) run in the form.
  Engine CHECK / FK / uniqueness still fail at execute time. Subquery `FROM`,
  joins, and `UNION` result grids stay read-only.
- **Format** — pretty-print the buffer. **Clear** removes results for the active tab.
- **Bookmarks** — save reusable snippets from the sidebar.
- **Variables** — named values reused as `${{name}}` or `${{name.col}}` (table
  column → list). Add them in the **Variables** sidebar; right-click a result
  **cell** (scalar), **column header** (list), or **# / empty grid** (table); or
  use leading comments so Run captures automatically — put `-- @set`
  **immediately above** the SELECT it applies to (not below the previous query):

  ```sql
  -- @set orderid
  SELECT id FROM "ORDER" ORDER BY id DESC FETCH FIRST 1 ROW ONLY;

  -- @set ids = column id
  SELECT id FROM ORDER_TIME WHERE orderId = ${{orderid}};

  -- @set t = table
  SELECT id, name FROM users;

  SELECT * FROM ORDER_ANSWER WHERE ORDERID IN (${{ids}});
  -- table column: ${{t.id}}   whole table: ${{t}} → VALUES (…)
  ```

  Typing `${{` / `${{name.` autocompletes names and table columns. Hover a ref for
  its value (or `N×M table`). Hover a statement in the strip (when it uses vars) to
  preview **query with values** and **Copy**. Statements in one Run are sequential
  so later SQL can use vars set by earlier `@set`. Multi-destination: `@set` uses
  the first successful server’s result. Substitution is local (values are pasted
  into the SQL text before send — not database bind parameters). Missing/empty
  vars fail the run with a clear error; failed `@set` shows an amber warning above
  the results.

  **Secrets** — mark a variable as secret to mask it in the sidebar, hover, and
  statement preview. Secret **values are session-only** (not written to
  localStorage); after reload, re-enter them or capture again with `@set` / the
  grid. Note: substitution still embeds the value in the SQL sent to the server.
  Secret variables **are available in code cells** as `vars.<name>.value` (for API
  tokens, etc.). `-- @node` cells send those values to the FoxSchema server worker
  under the same trust model as Node cells generally.

  **App Secrets vault** — use the **Secrets** sidebar to **Fetch** a key via a
  **named cloud credential** (Credentials → Cloud providers — e.g. “Prod AWS”),
  or **manually** enter a secret key. Secrets are registered as **Variables** with
  the secret flag — the UI shows **••••** only. On Fetch / Refresh / Run, FoxSchema
  resolves cloud refs with that credential’s tokens (or the host default chain when
  no credential is linked). Optional host packages:
  `@aws-sdk/client-secrets-manager`, `@google-cloud/secret-manager`,
  `@azure/keyvault-secrets` + `@azure/identity`.

  Vault secrets also merge into `vars` / `${{name}}` for that Run. A session Variable
  with the **same name wins** over a vault-only entry. Multi-user hosts should treat
  vault + cloud credentials as high privilege.

  **Per connection** — scalars and lists can override the global value per saved
  destination (expand **Per connection…** in the sidebar). Multi-destination runs
  substitute each server with its override. `@set` and grid capture still update
  the **global** base value.

  **Export / import** — download or upload JSON from the Variables panel. Secret
  entries export as stubs (name + flag only, no values). Click a table variable’s
  size line to preview columns and rows.
- **Max rows / Rows/page** — caps how many rows each statement returns per page (default
  200). Use **Next** / **Prev** on a result grid to page through more rows;
  visited pages stay cached in memory so going back does not re-query the server.
  Sibling result grids from the same Run sync vertical scroll by row index.
  **Last Id** (keyset) paging is used only for a single-table query whose
  `ORDER BY` is covered by a unique key. Subqueries, joins, `UNION` / set
  operations, and `CROSS` / `OUTER APPLY` fall back to `OFFSET` (Next/Prev still
  work; they just are not seek-based).
- **Code cells (JS / TS / Node)** — mix SQL with local transforms in the same buffer. Fence
  a cell with `-- @js` / `-- @ts` … `-- @end` (runs in the browser; inner semicolons are fine)
  or `-- @node` / `-- @nodets` … `-- @end` (runs on the FoxSchema **Node** server). You can use
  local `let`/`const`/`var`, **functions**, loops (`for`, `while`, `for…of`), **`async`/`await`**,
  and **`fetch`** (headers, query string, JSON body). Allowlisted **imports** (bundled, no CDN):
  `lodash`, `lodash-es`, `date-fns`, `@faker-js/faker` (English locale; call `faker.seed(n)`
  for reproducible values) — put `import` lines at the top of the cell. Prefer `//`
  comments inside cells (`--` is the JS decrement operator). Cells are **isolated**
  (imports/functions do not carry to the next cell; use `last` / `vars` to pass data).
  The cell receives `last` (previous statement’s grid) and `vars` (Variables **including
  secrets**, plus App Secrets vault entries for the Run). **You must `return`** either
  `{ columns, rows }` or an array of plain objects. Python is not available yet.

  In the SQL Editor sidebar, **Bookmarks → Add samples** installs ready-made ★ Sample
  scripts (also under `docs/examples/sql-editor/`) — including API POST with
  headers/query/body and Bearer from `vars.apiToken`.

  > **`-- @node` cells run code on the FoxSchema server.** They execute in a worker
  > thread with a scrubbed environment and a hard timeout, but the JS sandbox is a
  > guardrail against accidents, not a security boundary — a determined cell can still
  > reach the network from the server (`fetch`) and burn CPU. On a personal/desktop
  > install that is exactly the point. If you host FoxSchema for **multiple users**,
  > treat the ability to run `-- @node` cells as equivalent to giving those users a
  > shell on the server host, and only expose it to people you trust at that level.
  > Browser cells (`-- @js` / `-- @ts`) run in the user's own tab and carry no such risk.

  **Running SQL from a Node cell.** `-- @node` / `-- @nodets` cells get a `sql`
  tagged template bound to the credential the run is using. Interpolations become
  **bind parameters**, so values never become SQL text:

  ```sql
  -- @node
  const rows = [
    { id: 2, email: "o'brien@x.com", note: null },
    { id: 3, email: 'ada@x.com', note: 'new' },
  ];
  await sql`INSERT INTO ${sql.id('accounts')} ${sql.values(rows)}`;
  return await sql`SELECT id, email FROM accounts WHERE id IN ${[2, 3]}`;
  -- @end
  ```

  | Form | Produces |
  | --- | --- |
  | `${value}` | one bind parameter (`$1` / `?` / `:1` per dialect) |
  | `${[a, b]}` | an `IN` list — `($1, $2)` |
  | `sql.values(rows)` | `("a", "b") VALUES ($1, $2), ($3, $4)` from objects |
  | `sql.id('schema', 't')` | a quoted identifier (engines cannot bind these) |
  | `sql.raw(text)` | verbatim text — the one unescaped form, use deliberately |

  A value containing `'`, a `null`, a `Date` or an object is safe in every form
  except `sql.raw`. **Safe mode applies**: with it on, a cell's write/DDL
  statement is rejected server-side — turn it off to let cells write. Each
  `await sql` is its own round trip and may land on a different pooled
  connection, so transactions and temp tables do not carry across calls.

  ```sql
  SELECT id, email FROM user;

  -- @js
  import _ from 'lodash';

  function doubleRow(r) {
    return { id: r[0], name: r[1], n: Number(r[0]) * 2 };
  }
  return _.map(last.rows, doubleRow);
  -- @end
  ```

  Async + fetch (browser or Node):

  ```sql
  -- @node
  const res = await fetch('https://httpbin.org/get');
  const json = await res.json();
  return [{ status: res.status, url: json.url }];
  -- @end
  ```

- **Safe mode** — when on, UPDATE / DELETE / MERGE, upserts that can overwrite
  rows (`ON CONFLICT DO UPDATE`, `ON DUPLICATE KEY UPDATE`, `INSERT OR REPLACE`),
  and DDL need an extra confirmation before run. Plain INSERT (including insert
  CTEs and `ON CONFLICT DO NOTHING`) does not.

Writes and DDL are allowed when you confirm them. **SQLite** connections are
read-write (the file is opened that way on purpose). **ClickHouse** grid row
editing is blocked; other dialects that cannot apply a given write show a
clear error on that connection’s result cell.

Switch back to **Compare** anytime to compare and migrate schemas.

## Utilities

Left rail **Utils** — a workspace of its own, not a SQL Editor sidebar. Pick one
saved credential at the top, then a tool:

**Maintenance**

- **Index Management** — indexes grouped by table; filter by name or minimum
  fragmentation %; fetch fragmentation in batch (`POST /schema/index-fragmentation-batch`);
  defragment selected indexes or all filtered rows.
- **Clone Table** — archive a huge table as `name_1` / next free `name_N` (or a
  fixed starting number), then recreate an empty table with the original name and
  columns so apps keep working. Toggle **Keep indexes** and **Foreign keys (auto)**
  for the new table; Insert SQL or Apply. Inbound FKs from other tables still point
  at the archive until you update them.
- **Backup & Restore** — Fox Schema writes the backup and restore commands
  for this connection. The amber banner says *where* they run, because that is
  what the folder means:
  - **Your machine** (`pg_dump`, `mysqldump`, `sqlite3`, SqlPackage, `mongodump`,
    `redis-cli --rdb`) — the file is written where you paste and run the command.
  - **Database server** (SQL Server `BACKUP DATABASE`, Oracle Data Pump, Db2,
    ClickHouse, CockroachDB, DuckDB `EXPORT DATABASE`) — the folder is a path,
    DIRECTORY object, or allowed disk *on that server*.
  - **Cloud** (Redshift snapshots) — there is no file to place.

  Commands never contain the password (the notes say how the tool asks for it).
  Folder, format, scope, compression, and “only this schema” can be **Save as my
  default for** that engine (`GET` / `PUT /api/backup-settings`, per signed-in
  user). Table filters and the generated file name are not saved. SQL commands
  (SQL Server, CockroachDB, ClickHouse, DuckDB) offer **Open in SQL Editor**;
  shell tools you copy. Names with spaces are quoted so a pasted command does
  not split.

  Where the backup is SQL the database server runs (SQL Server, CockroachDB,
  ClickHouse, DuckDB), **Run backup now** runs it on this connection after a
  confirmation that names the file and the connection. It needs **Change
  schema** (`editor.ddl`), because the server treats BACKUP as a schema change.
  Where the server records its backups (SQL Server's `msdb`, Db2's
  `DB_HISTORY`, ClickHouse's `system.backups`), **List backups on this server**
  shows them newest first; **Restore this** points the restore command at that
  backup, and **Restore the newest instead** puts it back. A restore is never
  run from here: it replaces a database, so it stays a command you open in the
  SQL Editor and run yourself.

**Insights** (estimated where the engine has no physical figure)

- **Connection Pool**, **User Connections**, **System Info**, **Table & Index Size**.
  DuckDB reports worker threads, buffer memory, and database-file blocks (no
  per-table bytes — row counts are estimates). SQLite / DuckDB have no server pool
  or multi-user sessions.

**Access**

- **DB users & grants** — same catalog as the Access workspace
  (`POST /schema/db-access`). GRANT / REVOKE still needs **Grant privileges**.

**Files**

- **Query files** — import **CSV/TSV** (comma, tab, semicolon, pipe, or custom),
  **JSON** (array or NDJSON), or **fixed-width text** (column start/length offsets).
  **Destination** choices:
  - **New temp SQLite workspace** (default) — short-lived `Files: …` credential;
    add more files later so several tables share one temp DB.
  - **Import into saved credential** — create a table on a saved server using
    chunked multi-row `INSERT` bulk loads.
  Large pastes/files upload in **chunks** (disk-backed session). List workspace
  tables, click one to load a sample SELECT in the Editor, delete one workspace,
  or clear all. **Replace previous file imports** (off by default) deletes earlier
  `Files:` workspaces when you create a new one; **Replace table if it exists**
  applies when adding to a workspace or credential. Temp DBs expire after about
  24 hours. **Insert SQL** from Clone Table / the table blueprint writes into the
  Editor tab even if the Editor is not on screen.

## Workflow

Optional workspace for scheduled and triggered jobs (SQL, HTTP, files, email/SMS)
beside Compare and the SQL Editor. The designer lives in the Fox Schema UI;
a **separate engine process** runs the jobs.

Developer / ops runbook: [WORKFLOW.md](WORKFLOW.md). Env vars:
[DEPLOYMENT.md](DEPLOYMENT.md#workflow-engine).

1. Start the engine beside Fox Schema (`npm run dev:with-workflow` in a checkout,
   or deploy `apps/workflow-server` next to Docker/CLI). The published Docker
   image is Fox Schema only — it does not start the engine.
2. Open **Workflow** on the activity rail.
3. **Engine** tab: health should read `engine ok`. Set state to **Enabled** and
   **Save settings**. New installs default to **Disabled**, so Run does nothing
   useful until you enable it.
4. **Designer**: drop a trigger (Manual, Schedule, Webhook, API Endpoint, …) and
   pipes. Picking a saved connection on a **SQL query** / **SQL write** pipe
   **links** it — Fox Schema records the grant; the pipe never holds a password.
5. **Run** from the designer, or let cron / webhook / poll fire. **Runs** lists
   history. **Variables** and **Credentials** are per-engine; linked Fox Schema
   connections show up as `foxschema-…` credentials.

Permissions (multi-user): **Open Workflow** to see the pane; **Design** to edit;
**Run** to start jobs; **Workflow admin** for the Engine tab. Viewers can open
Workflow and read runs without seeing Designer chrome.

## Access control

On a multi-user install, **Profile → Access control** assigns Fox Schema roles
(`viewer` / `editor` / `owner` / `admin`) and permission keys — that is **app**
access, not GRANT on a connected database.

**Database** users and privileges have two entry points that share one catalog
API (`POST /schema/db-access`):

- **Access** workspace (needs any `access.*` tab permission, including
  **Open Access**).
- **Utils → DB users & grants** (needs **Use utilities**).

Either family may load the catalog. Running GRANT / REVOKE still needs
**Grant privileges** (`editor.grant`). SQLite / DuckDB have no GRANT catalog;
ClickHouse has no permission builder yet.

The Access workspace opens on **Permissions** (a principal list). Pick a user
or role, then **Account** / **Grants** / **Effective**:

- **Account** — identity, membership, add / drop.
- **Grants** — one view: an object × privilege grid that opens on what that
  principal **holds now** (EXECUTE on procedures and functions included), a line
  under it listing what it also holds that the grid cannot show, and the
  database- and schema-wide grants to edit those. A new tick is GRANT; clearing a held box is REVOKE. Boxes that
  already match the catalog do not appear in the SQL. Privileges the grid cannot
  show (CONNECT on the database, USAGE on a schema, DENY, unknown verbs) are
  never touched — ticking SELECT on one table does not revoke the rest of the
  role. When a catalog row or a grant is missing a schema (MySQL by-name
  grants), the grid still matches on the object name.
- **Effective** — what they can actually do, including privileges inherited
  through roles.

**Users** is CREATE / ALTER / DROP USER and ROLE. **Diff** is a separate tab:
you write a desired grant set, load the live catalog, and copy reconciliation
SQL (including DENY gaps). Fox Schema never applies Diff SQL from that screen.

What the catalog shows:

- **Roles and groups** are listed apart from users on every engine that has
  them — MySQL, MariaDB and TiDB roles included — with who belongs to each.
  Every screen reads membership from one reconciled answer, so the list and
  the detail pane agree.
- **Allow-all accounts** carry an `allow-all` or `superuser` tag: a superuser
  (Postgres `rolsuper`, SQL Server `sysadmin`), every privilege on the whole
  server (`ON *.*`), or control of the whole database (SQL Server `db_owner`).
  Inherited through a role counts, and the banner says which role. Type
  `allow-all` or `superuser` in the filter to list only those.
- A **complete privilege set** on one object is one `ALL PRIVILEGES` row, which
  expands to the individual privileges and has **Revoke all**. `grantable`
  marks a privilege held WITH GRANT OPTION.

Granting:

- **Membership of a role** offers the listed roles and groups the principal is
  not yet in; **Other…** still takes a typed name.
- **All privileges (allow-all)** grants the engine's widest form — `*.*` or a
  whole database on the MySQL family and ClickHouse, a database or schema on
  Postgres (which reads no table; server-wide there is superuser), `CONTROL` on
  SQL Server, `ALL PRIVILEGES` on Oracle, `DBADM` on Db2. It states what it
  confers, and Run stays disabled until the principal's name is typed.
- **Add user / Add role** can put the new account in existing roles. On MySQL
  and TiDB it also emits `SET DEFAULT ROLE ALL`, and on MariaDB
  `SET DEFAULT ROLE`, because a granted role is otherwise inactive at login.

## Snapshots (schema history)

Left rail **Snapshots**. This tracks versions of **one** database (not a second
live connection). It is not the same list as **Applies** (migration runs) at the
bottom of the rail.

1. Pick a saved credential and **Take first snapshot** (or snapshot again after a
   live change). Applying a Compare migration also records a version.
2. The **graph** stays on screen while it reloads; use **Graph** to hide it.
3. **Original** and **Target** work like Compare: Original is a version; Target is
   the live database or another version. Changing the pickers does not hide the
   graph.
4. **Compare versions** is a preview. Nothing writes the live database until you
   press **Update** / **Revert**.
5. **Revert** always runs against the **live** database this history was captured
   from, snapshots first, and **appends** a new version (it never rewrites the
   version you picked). Tick objects, or **Select all**. Nothing ticked means
   nothing runs. A plan that would destroy data needs an extra confirmation; a
   **blocked** plan is refused. The button says **Update** when the plan only
   adds (the database has fallen behind) and **Revert** when it rolls back.
6. **Force migrate…** applies a stored version to a **different** database. It
   picks its own version and target (not whatever the graph is showing). You must
   confirm “this is not the history’s database”; if the plan destroys data you
   also confirm that. Those two acknowledgements are separate — agreeing to data
   loss is not agreeing to target another database.

View / routine / trigger “sameness” uses the **same rules as Compare**
(`normalizeDefinitionText` in `@foxschema/sql`): whitespace and a trailing `;`
are formatting; keyword and identifier case is folded; this history’s schema
qualifier is ignored (`app.orders` = `orders`); **string-literal case is kept**.
The definition Lokee stores is still the captured text — revert builds DDL from
it. After upgrading, the first capture of an existing history may record **one
extra version** for objects whose hash changed under the new rule; later versions
appear only for real changes.

SQLite and DuckDB file credentials can be picked from a Browse dialog on the
machine running Fox Schema.

## Applies (migration runs)

Bottom of the left rail, **Applies**. Every Schema Compare migration you apply is
recorded — status, target, the exact script, the pre-migration snapshot, and
per-object results. No passwords are stored. Data migrate has its own history in
the Editor. A migration run from Git also shows the commit it applied; **Git**
in the header opens the branch view described in
[Commit the migration to Git first](#commit-the-migration-to-git-first).

## Troubleshooting

**UI looks disconnected / API returns 403 "This origin is not allowed".** In
`npm run dev`, Vite binds every address and prints a **Network:** URL. Dev
allows Origins on this machine's own literal IPs at ports **5173**, **5199**,
**3210**, and **3211** — not an arbitrary hostname (DNS rebinding). Opening
`http://<this-machine-ip>:5173` works; `http://evil.com:5173` does not. In
production, UI and API share one origin; for a split hostname set
`FOX_ALLOWED_ORIGINS`. See [DEPLOYMENT.md](DEPLOYMENT.md#origin-policy).

**"Connection failed" / timeout.** Check host, port, and that the database accepts
connections from where Fox Schema runs (in Docker, `localhost` means *inside the container* —
use the host's IP or a service name, not `localhost`, to reach a DB on your machine).

**Port already in use (CLI).** Default is **3210**. If another app owns it,
`foxschema open` moves to the next free port (unless you passed `--port`).
Or stop Fox (`foxschema stop`) / free the port, then run `foxschema` again.

**Is the backend still running?** Closing the browser does **not** stop the
server. Check with `foxschema doctor` (shows **ui lock pid** and whether
http://localhost:3210 is up). In **Activity Monitor** / **Task Manager**, look
for process title **`foxschema`** (or `node` with `ui-server` in the command
line). Stop it with `foxschema stop`.

**Port already in use (Docker).** Change `PORT` in `.env` and restart
(`docker compose -f docker-compose.app.yml up -d`).

**"driver not installed" for a database type.** Some drivers are optional/platform-
specific (notably IBM Db2 / `ibm_db`). Prefer:

```bash
foxschema drivers install db2
foxschema stop && foxschema
foxschema doctor
```

In a monorepo checkout you can also run
`npm install ibm_db@4.0.1 --foreground-scripts -w @foxschema/db`
(install into **@foxschema/db**, not only `@foxschema/web` — that is where the
driver is loaded from).
Install scripts **must** run (do not set `ignore-scripts`) so the IBM clidriver
downloads. On **linux/arm64**, `ibm_db` has no build — use Docker
`5nickels/foxschema:latest` (linux/amd64). See [DEPLOYMENT.md](DEPLOYMENT.md#database-drivers).

**Saved passwords stopped working.** The encryption key changed. For the CLI, keep the
same data directory; for Docker, restore the original `APP_ENCRYPTION_KEY` / volume, or
re-enter the passwords.

**Desktop shortcut does nothing / browser does not open.** Run `foxschema doctor`, then
`foxschema` from a terminal. Re-create the shortcut with `foxschema shortcut`.

**Lost my saved connections/history after a restart (Docker).** The app data lives on
the `/data` volume — make sure you didn't remove it (`docker compose down -v` deletes
volumes). See [DEPLOYMENT.md](DEPLOYMENT.md).

**Signed out while the UI was open.** A session unused for **8 hours** ends,
whatever its 7-day expiry (`FOX_SESSION_IDLE_HOURS`; `0` turns the idle limit
off). From the profile menu, **Sign out other sessions** ends every session
except this one — useful if you left a browser open elsewhere.

**Workflow engine down / Run refused.** The designer is in the UI; jobs run in a
separate process. Check **Workflow → Engine** health. New installs default to
**Disabled** — set **Enabled** and Save. `FOXFLOW_ENCRYPTION_KEY` is required at
engine boot. Saved connections need both `WORKFLOW_ENGINE_TOKEN` (same value on
FoxSchema and the engine) and an explicit grant (pick the connection on a SQL
pipe). The published Docker image does not start the engine. See
[WORKFLOW.md](WORKFLOW.md).

Still stuck? Open a GitHub issue with what you did and the error you saw.
