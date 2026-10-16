# Release summary

One page for every version that has ship notes. The full text of a version stays in its own file; those files are history and are not rewritten after the version ships.

Current map of the product: [CODE_MAP.md](../CODE_MAP.md). How to install: [install.md](../install.md).

## Not yet shipped

[UNRELEASED.md](UNRELEASED.md)

- Snapshots (schema history) and Applies (migration runs) are separate rail items. Utils is its own view.
- Connections, snapshots, secrets, and migration history belong to a workspace. One workspace is active at a time.
- Every install requires sign-in. `foxschema open` on a personal machine can start with a one-time launch link, then asks you to create an account.
- Invites, forgot-password, and Google / GitHub / Microsoft sign-in. SSO accepts only verified emails.
- Migrations in Git, and Utils → Backup & Restore.
- Send feedback opens a pre-filled GitHub issue. Fox Schema does not post it.
- Schema history uses the same definition comparison as Compare.

## 0.2.111

[RELEASE_0.2.111.md](RELEASE_0.2.111.md) — since 0.2.73

- Schema History in Schema Sync: snapshot one database, compare versions, revert only the current database after a new snapshot.
- One table blueprint in Compare, Browse, History, and Edit table. Browse is its own pane.
- SQL Editor: copy from result grids, routines stay one cell, Safe mode does not confirm plain reads.
- Db2 reorg after `DROP COLUMN`. Oracle number and sequence generation fixes.
- MongoDB and Redis listed with the other dialects.

## 0.2.81

[RELEASE_0.2.81.md](RELEASE_0.2.81.md) — since 0.2.73

- Lokee Weave: schema version graph, capture from a saved credential, name and describe a version.
- Node code cells block `import()` / `eval` breakouts.
- Compare Data can back up and restore when a migrate fails part way.

## 0.2.73

[RELEASE_0.2.73.md](RELEASE_0.2.73.md) — patch on 0.2.72

- The credential dialect filter lists every engine, including MongoDB and Redis.
- New credentials default to PostgreSQL.

## 0.2.72

[RELEASE_0.2.72.md](RELEASE_0.2.72.md) — patch on 0.2.71

- MongoDB and Redis appear on the credential form and in `foxschema drivers list`.
- Redis honours WHERE on UPDATE/DELETE. MongoDB refuses `WHERE col = NULL` matches on missing fields.

## 0.2.71

[RELEASE_0.2.71.md](RELEASE_0.2.71.md) — since 0.2.50

- Maximize, copy, and JSON export on SQL Editor result grids.
- Index renames no longer mark the whole table modified.
- Db2 driver install runs where `require('ibm_db')` actually loads.
- Streaming CSV and incremental NDJSON import.

## 0.2.49 and 0.2.50

[RELEASE_0.2.49_50.md](RELEASE_0.2.49_50.md) — since 0.2.36

- Compare data side by side, align rows by key, sync scroll, and export every grid as one CSV.
- Edit rows in SQL Editor result grids when the key is in the result.
- Default port is **3210**. In-app **Update now** installs the latest npm package and restarts.

## 0.2.36

[RELEASE_0.2.36.md](RELEASE_0.2.36.md) — since 0.2.33

- The last active admin cannot be demoted or deactivated.
- `packages/core` split into `@foxschema/sql` (dialect knowledge) and `@foxschema/db` (drivers). No change in how the app behaves.

## 0.2.33

[RELEASE_0.2.33.md](RELEASE_0.2.33.md) — since 0.2.31

- SQL Editor column picker and automatic table aliases.
- Access control: active flag, admin password change, press-and-hold to show a password.

## 0.2.16

[RELEASE_0.2.16.md](RELEASE_0.2.16.md) — since 0.2.10

- `foxschema open` restarts a server that is still the previous version.
- Owner role. Editor write permission split into DML, DDL, and grant.
- CI scans installed packages for dangerous install scripts.

## 0.2.10

[RELEASE_0.2.10.md](RELEASE_0.2.10.md) — ship of 0.2.5 through 0.2.9, since 0.2.4

[RELEASE_0.2.9.md](RELEASE_0.2.9.md) describes the same feature set. 0.2.10 is the published cut.

- Utilities: Query files and Server Insights.
- Editable Data Peek. Roles: admin, editor, viewer.
- CockroachDB migrations drop and recreate dependents around a structural ALTER.
- Desktop Tauri app retired. Use the CLI or Docker.
- Upgrade keeps `/data` and `APP_ENCRYPTION_KEY`.

## 0.2.0

[RELEASE_0.2.0.md](RELEASE_0.2.0.md)

- SQL Editor next to schema compare: multi-destination run, notebook cells, FoxScript, and Data Peek.
