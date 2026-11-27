# Unreleased

Notes for the next release. At ship time, rename this file to that version's
`RELEASE_<version>.md` and use it as the GitHub Release body.

## Utilities → Drop Type

Drop a user-defined type (enum, domain, alias type). Fox lists what uses it —
columns, other types, and views, functions, procedures and triggers that may
name it — then writes the steps: move each column onto a built-in type (the
values stay; for an enum, optionally a check constraint keeps the allowed
values), then drop the type. Never `CASCADE`. Copy, open in the editor, or
execute them here. PostgreSQL, YugabyteDB, CockroachDB, SQL Server, Azure SQL
and DuckDB; on Oracle and Db2, and for a PostgreSQL composite type, a type no
column uses.

**PostgreSQL composite types are read.** `CREATE TYPE … AS (…)` types now
appear with their fields in the schema tree, Compare and migration scripts
(PostgreSQL, YugabyteDB, CockroachDB).

**PostgreSQL domains in Compare and migration scripts.** A domain was
scripted as `CREATE TYPE email AS varchar(120)`, which PostgreSQL rejects,
and dropped with `DROP TYPE`, which it also rejects. It is now
`CREATE DOMAIN` with its `DEFAULT`, `NOT NULL` and named `CHECK`s, and
`DROP DOMAIN`. Those rules are read from the catalog, so Compare also shows a
domain whose rules differ between two databases.

**Rename Column on SQL Server keeps a named default's name.** A type change
takes the column's default off and puts it back; a default someone named
(`CONSTRAINT df_orders_phone DEFAULT …`) came back with a name SQL Server
made up. It now keeps its name.

## Google sign-in can connect Google Cloud

An admin can turn on **Also connect Google Cloud for secrets** on the Google
card under Access control → Sign-in (or `SSO_GOOGLE_CONNECT_GCP=on`). Signing
in with Google then also asks for read-only Google Cloud access, and the first
grant saves a **Google Cloud** connection in the person's personal workspace,
ready for **Secrets → Fetch**. Off by default. A connection already there is
never replaced, turning the access down still signs you in, and it needs the
install's own Google app (the Fox sign-in service cannot grant it). With a
dedicated Google Cloud client (`GCP_OAUTH_CLIENT_ID`) it stays off, because the
token would not refresh with that client.

## Interpolate Variables and Secrets into SQL

**Insert** on a Variables or Secrets row puts `${{name}}` at the editor cursor.
Run still substitutes the real value into the SQL sent to the engine. Secret
payloads stay out of **Out [n]** labels, copy-with-values, and **Recent**
(those keep `${{name}}` or `(secret)`). Public variables still fill in Recent
and labels as before.

## Google Cloud secrets: Connect Google Cloud (OAuth)

**Connect Google Cloud** on Credentials → Cloud providers (or SQL Editor →
Secrets) opens this install’s own Google OAuth client — PKCE, offline access,
`cloud-platform.read-only`. Only the **refresh token** is stored, encrypted, on
the named credential. Fetch lists projects / secrets / versions so you pick
instead of typing a resource name; the value is injected into session Variables
and is never written to `app_secrets.encrypted_value`. Disconnect revokes at
Google, then deletes the credential.

Register the callback
`{public URL}/api/app-secrets/providers/gcp/oauth/callback` on the same Google
OAuth app as Access control → Sign-in → Google. The Fox sign-in service
(foxschema.com) cannot access Secret Manager.

Google Cloud warns that downloaded service-account keys pose a risk if
compromised. New named GCP credentials **refuse** a `private_key` JSON.
Interactive use is **Connect Google Cloud**. Machines paste a Workload
Identity Federation `external_account` client config (no private key), or
use the host identity (ADC / GCE metadata, including WIF via
`GOOGLE_APPLICATION_CREDENTIALS`). Existing stored keys still resolve until
you replace them. AWS and Azure fetch are unchanged.

A pasted Workload Identity Federation config is checked before it is saved and
before each use: its endpoints must be Google’s, and its token may come only
from a file or URL listed in `FOX_GCP_WIF_TOKEN_FILES` / `FOX_GCP_WIF_TOKEN_URLS`
on the server. Nothing is listed by default. Connecting under a name already in
use reconnects that Google Cloud connection and needs **Edit secrets**; it never
replaces another kind of credential.

## Unified install encryption key & derived first-run setup code

- **One key on first boot.** Docker (`docker-entrypoint.sh`), the CLI (`foxschema open`), and `serve.ts` auto-load or auto-generate the install encryption key on first boot and share it across both `APP_ENCRYPTION_KEY` and `FOXFLOW_ENCRYPTION_KEY`, so the sandboxed workflow engine starts out of the box without configuring a second key.
- **Deterministic first-run setup code.** When setting up the first administrator account from another machine, the `XXXX-XXXX` setup code printed in the server log is derived from the install encryption key (`HMAC-SHA256`), so it survives container or server restarts during initial setup. The setup screen accepts either the short `XXXX-XXXX` log code or the raw `APP_ENCRYPTION_KEY`.

## Compare & Browse: Rollback SQL preview, Open in SQL Editor, Saved compare pairs, and Table DDL

- **Up (Migrate) / Down (Rollback) SQL preview.** On the **Migration SQL** tab, switch between **Up (Migrate)** and **Down (Rollback)** to inspect, copy, or download (`Download .sql`) either the forward migration script or the inverse rollback DDL across all 14 SQL dialects.
- **Open in SQL Editor.** Both the **Diff briefing** panel and the **Migration SQL** tab offer **Open in SQL Editor** and **Download `.sql`**, loading the generated script directly into the SQL Editor bound to the Target connection.
- **Saved compare pairs.** Pin any `(Original → Target)` connection pair in the Compare toolbar (`Pin pair`) and switch between saved pairs in one click from the **Saved pairs** dropdown.
- **Browse `CREATE TABLE` DDL.** Browsing a single schema in **Browse** mode now renders formatted `CREATE TABLE` DDL with a **Copy DDL** button alongside column and index blueprints.

## Workflow DBA pipelines, new transform pipes, and SQL Editor shortcuts

- **Three new data/DBA transform pipes:** **Deduplicate rows** (`transform.dedupe`), **Aggregate / group rows** (`transform.aggregate`), and **Redact / mask fields** (`transform.redact` — mask, SHA-256 hash, last-4, email domain, or drop), with visual configuration forms in the Workflow Inspector.
- **Four practical DBA sample workflows:** **Add samples** now installs **DBA: Schema & Catalog Health Audit**, **DBA: Table Retention & Archival Maintenance**, **DBA: Ledger Verify & Quarantine**, and **DBA: PII Redact, Dedupe & Rollup**, with category filter chips (**All**, **DBA & SQL**, **Samples**, **Scheduled / Webhook**), 1-click **Run** from the Workflows list, and **Re-run** / **Open workflow** from Runs.
- **SQL Editor UX:** Added view-wide keyboard shortcuts (`Cmd/Ctrl+S` bookmark, `Cmd/Ctrl+Shift+F` format SQL, `Cmd/Ctrl+Shift+S` toggle Safe mode) and status-bar split-ratio presets (**Editor 75%**, **50:50**, **Results 78%**).
