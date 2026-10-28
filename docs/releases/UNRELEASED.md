# Unreleased

Notes for the next release. At ship time, rename this file to that version's
`RELEASE_<version>.md` and use it as the GitHub Release body.

## Data compare: 2,000 rows in key order; migrate the same window

**Compare data** still lines up the pages each grid has already loaded, and
one-sided rows on a cut-short page stay unresolved. **Compare 2,000 rows**
re-reads both sides in key order — a fixed window, not a setting — and
classifies every row inside it. Filters (All / Changed / Only in source /
Only in target / Unresolved / Matching) and pages (50–500) walk that window
in memory. **Back to loaded rows** returns to the grids you ran. Redis and
MongoDB have no ordered window.

**Data migrate** applies up to **2,000** row ops. The screen and
`POST /api/data-migrate/execute` share one number (`DATA_MIGRATE_MAX_OPS`),
so a compare window's differences can be applied from the screen that found
them. Past 2,000 ops still points at Server Beam.

## Read-only is a permission

**Save and change** (`app.write`) is install-wide. Without it an account may
call only GET, or a route that declares it reads (running a SELECT, comparing,
loading a schema). The **Demo** role is the role without it and without
**Manage own account** — a published demo's shared login. Strip `app.write`
from any role and those accounts read only too. A new POST is closed to such
an account until its route declares `reads`. See
[DEPLOYMENT.md](../DEPLOYMENT.md#publishing-a-demo).

## Personal workspaces lend no more than the account holds

A viewer account can still share its workspace and manage members, but it
invites viewers only — never an editor or owner who could run DDL or GRANT
with credentials handed out for reading. A membership stored above that
ceiling still acts at the ceiling. A demo login is a viewer in every
workspace. Shared workspace owners can still grant owner.

## Redis keys as tables

A Redis prefix (`users` → `users:*`) is one table, one key per row: hash
fields and JSON object fields become columns. A list, set, sorted set or
stream key is a table of its own; its elements are the rows. Every read is
bounded (no `KEYS`, no whole-key `LRANGE`).

## One workspace on the rail

The workspace you are in sits under the Fox mark on the left rail — switch,
invites (amber dot), settings, public join, and create. It is no longer inside
the profile menu. A launch session hides the button. SQL editor tabs in this
browser follow the workspace.

## SQL Editor: the schema you are browsing, and one transaction

Run applies the saved connection's schema (`CURRENT SCHEMA` / `search_path`)
so unqualified names resolve to the tables the explorer shows, not the
database user's default. Picking a connection in the explorer checks that
destination alone. **One transaction** wraps a multi-statement SQL run per
destination; a failure rolls it back. Code cells and `-- @set` stay statement
by statement. Redis, MongoDB and ClickHouse cannot roll back, so a Run with One
transaction is refused there.

## SQL Editor: the run rail, and installing a missing driver

Each statement's ▶ and run checkbox sit on a rail left of the editor, with its
**In [n]** number — the one the Run tooltip and `Out [n]` use. Click the number
to select the statement. With Safe mode on it turns amber for a write Run will
confirm, and red with `!` for an UPDATE or DELETE with no WHERE. Two statements
on one line get a row each, and a long statement's row stays at the top while
you read through it. Hover a row for its copy button, which copies the
statement with its variables filled in (secrets masked).

When a credential's driver package is missing, the schema browser and a failed
run — in either results layout — offer **Install driver**. Installing runs npm
on the server, so it needs the new **Install drivers** permission (admins by
default, from the account role); without it the banner gives the command to run.
Every Install button shares one status, and the server runs one install at a time.

## Workflow: steer a paused run; connections stay in their workspace

**Runs** can cancel a live job and answer **Ask a person**. Saving or running
a workflow that names another workspace's connection is refused — the engine
is install-wide; the connection is not.

## Index custom SQL is read-only; Db2 reorgs the table's indexes

A custom fragmentation probe must be one `SELECT`. GRANT / REVOKE scripts stop
at the first failure. Db2 defrag reorganises every index on the table, quoting
catalog names.

## Left-rail views

- **Snapshots** is its own left-rail view (schema history / Lokee). **Applies**
  at the bottom of the rail is migration-run history. They are not the same list.
- **Utils** is its own view (Index Management, **Backup & Restore**, Clone
  Table, insights, Query files, DB users & grants) — not a SQL Editor sidebar.
- Saved credentials are grouped by dialect; Home continues last compare / query.
  **⌘K** / the command palette list the same views the rail shows.

## Team workspaces

Connections, snapshots, migration runs, secrets and data-migrate history belong
to a **workspace**, not to one account. Every account has a personal workspace
(always private; its role follows the account). Admins create shared ones;
**Members can create workspaces** lets others. Invite by email — they join when
they accept (14 days). A workspace is **private** (invite only) or **public**
(anyone signed in can join as viewer or editor, never owner). Admins see every
workspace under Access control → Workspaces and open one only by joining.
Install keys (code cells, Git, workflow, admin, create-workspace) come from the
account role; the rest from the member’s role in this workspace.

## Execute opens the review for a conflict

A missing foreign-key target or an unacknowledged narrowing type change used
to leave Execute looking runnable while a click still deployed. The button
stays clickable and **opens that review** instead. Drop dependencies,
destructive drops, MySQL binlog risk, a required Git commit and a disconnected
target still disable it.

## SQL is classified the way the database reads it

Permission gates, data-migrate and the single-statement check lex SQL with
the destination dialect’s readings (MySQL `#` / `/*!…*/`, PostgreSQL dollar
quotes, session `sql_mode`, …). A closed `-- @node` … `-- @end` fence that
reaches `/sql/execute` is two comments; the SQL between them is still priced.
The splitter and the keyword-scan stripper share one tokenizer.

## Send feedback

**Send feedback** on the profile menu turns a bug, an idea or a question into a
GitHub issue. It opens pre-filled on GitHub and you submit it with your own
account: Fox Schema holds no token and posts nothing. The app details it adds
(version, browser, workspace, engines in use, never a host or database) are
listed first and can be left out, and a line that looks like a password is
flagged before anything leaves.

## A development server stays on this machine

- Without `NODE_ENV=production`, `npm start` in `apps/web` now listens on
  `127.0.0.1` instead of every address, and a network `LISTEN_HOST` is refused
  at startup. Such a server encrypts saved credentials with a development key
  and sends its session cookie without the Secure flag. To serve the network,
  set `NODE_ENV=production` (with `APP_ENCRYPTION_KEY`), as Docker does; for a
  development server on a network you trust, set `FOX_INSECURE_DEV=1`.

## Origin policy

`npm run dev` allows this machine's own literal IPs on ports 5173 / 5199 / 3210 /
3211, so a Vite **Network:** URL works. Arbitrary hostnames are still refused.
Production stays same-origin; set `FOX_ALLOWED_ORIGINS` for a split hostname.
See [DEPLOYMENT.md](../DEPLOYMENT.md#origin-policy).

## Schema history (Lokee): definitions are compared the way Compare compares them

Compare and Lokee used to decide "is this view / routine / trigger the same?"
differently. Compare folded case and dropped schema qualifiers; Lokee only
collapsed whitespace. So an object Compare called **unchanged** could still get
a new Lokee version — for example after the engine re-cased a view on storage,
or when the same body was captured with and without its `schema.` prefix.

Both now use one rule (`normalizeDefinitionText` in `@foxschema/sql`):

- whitespace and a trailing `;` are formatting;
- keyword and identifier case is folded;
- the history's own schema qualifier is ignored (`app.orders` = `orders`);
- **the case inside string literals is kept**: `status = 'Active'` and
  `status = 'active'` select different rows. Compare used to fold these too and
  report a real change as unchanged; it now reports it as modified.

Lokee applies the rule only when computing an object's hash. The definition it
stores is still exactly as captured, because revert builds its DDL from it.

### What you will see once

Hashes of views, routines and triggers change under the new rule. The first
capture of each existing history after upgrading records **one new version**
listing those objects as modified, although their text has not changed. After
that capture, versions appear only for real changes.

Revert and force-migrate are not affected by the boundary: when two stored
versions' hashes differ, both sides are re-hashed with the current rule before
deciding whether an object changed.

## Sign-in is required on every install

Fox used to open straight into the workspace on a personal install, and a
multi-user server let anyone register. Both are gone: **every install now asks
for an email and password**, and only an administrator can create accounts.

- **First launch** shows *Create the administrator account*. On an install used
  before, this claims the existing local account, so saved connections, history
  and workflows stay where they are. When the install is bound to an email
  (`APP_USER_EMAIL`), that email is used.
- **Setup code.** From the machine Fox runs on, setup needs only the password.
  From anywhere else, including through a reverse proxy, setup also asks for a
  one-time code that the server prints to its log (`docker logs <container>` on
  Docker). Setup closes for good once an account can sign in.
- **No self-registration.** `POST /api/auth/register` answers 403. Admins add
  people from the **Add user** form in the admin Access panel with a starting password and a role.
- **SSO signs in existing accounts only.** A first SSO sign-in no longer creates
  an account; an admin adds the email first.
- **Sign-in is rate-limited** to 20 attempts per 15 minutes per client.
- A server that already ran with `LOCAL_SINGLE_USER=false` keeps its accounts and
  is never offered setup. `AUTH_REQUIRED` is no longer read; `LOCAL_SINGLE_USER`
  now only marks a personal install (machine-level actions such as driver
  install and updates).

## Start using Fox before creating an account

`foxschema open` now opens straight into the workspace on a personal install,
signed in as its owner through a one-time launch link: no account first. A
banner asks you to **Create your account** (also in the profile menu, where *App
users & roles* waits for the account); after 7 days
(`FOX_REGISTRATION_GRACE_DAYS`) Fox asks for it before anything else, and adding
users or changing sign-in settings needs it from the start. The *Get product
updates* screen is skipped: the account form offers Fox news instead.

- The link works once, for two minutes, only from the machine Fox runs on, and
  only while Fox listens on that machine alone. Docker images, shared servers
  and installs opened to the network keep first-run setup as before.
- **Verify your email.** The account created at setup is sent a code, entered in
  a banner. It goes through the install's SMTP relay when one is set up,
  otherwise through the Fox mail service on foxschema.com (`FOX_VERIFY_MAIL_URL`;
  `off` to send nowhere). Accounts an admin adds are not asked.

## Sign-in: invites, forgot password, Google / Microsoft / GitHub

- **New sign-in pages.** First launch is a *Create your account* page; the
  sign-in page adds **Forgot password?** and **Have an invite or reset code?**.
  New passwords are checked as you type against the server's own rules, and a
  Caps Lock warning shows on password fields.
- **Invites.** *Add user* without a password sends a one-time invite code; the
  person chooses their own password. Unaccepted invites are marked *Invited*,
  and each user row can resend an invite or send a reset code.
- **Forgot password.** A one-time code (30 minutes, single use) by email, or,
  without email set up, in the server log and via
  `foxschema reset-password [email]`. Setting the new password signs out every
  other session. The reply never says whether the email has an account.
- **Email me Fox news** on *Create your account* and when accepting an invite:
  unticked by default; when ticked, the email goes to the Fox subscriber list
  (the same foxschema.com endpoint as the first-run wizard, which notifies
  contact@foxschema.com). Never sent on a password reset, and a signup service
  that is down never blocks creating the account.
- **Google and GitHub with no OAuth app of your own**: turn on *Use the Fox
  sign-in service* (Access control → Sign-in, or `FOX_SSO_BROKER=on`).
  foxschema.com does the sign-in and returns a signed, single-use assertion
  bound to this install's callback and the browser that started; only
  existing accounts sign in. Off by default, since it trusts foxschema.com to
  say who is signing in.
- **Admin → Access control → Sign-in** configures Google, Microsoft and GitHub
  sign-in (with the redirect URL to register), the email relay (Hostinger /
  Gmail / Microsoft 365 presets and a test button) and the public URL — for the
  desktop app, where there are no environment variables to set. Environment
  variables still win and show read-only.

### Security fixes

- **SSO accepted unverified emails.** Microsoft's `email` claim with the
  multi-tenant endpoint is whatever any tenant's admin typed, so an attacker
  with their own tenant could sign in as any Fox user whose email they set
  ("nOAuth"). Microsoft now accepts only personal accounts, verified domains
  (`xms_edov`) or the configured tenant; Google requires `email_verified`;
  GitHub uses only the verified primary address. SSO also uses PKCE now.
- **Rate limits could be skipped** by sending a made-up `X-Forwarded-For`: every
  peer's forwarding headers were trusted. Now only loopback and private-network
  peers are (`FOX_TRUST_PROXY` to change).
- **Per-email sign-in lockout**: 5 failures lock the email for 15 minutes, for
  emails with and without accounts alike; a wrong email now costs the same
  time as a wrong password.
- **Session tokens are stored hashed.** Migration 20 clears existing sessions,
  so **everyone signs in once more** after upgrading.
- **Password rules**: at least 10 characters, not a common password, not the
  email name. Existing passwords keep working.

## Migrations in Git

Commit a migration to a Git repository before it runs, and run teammates'
migrations from theirs. Built in (no `git` binary needed); works with GitHub,
GitLab, Bitbucket and Azure DevOps over HTTPS with an access token.

- **Access control → Git** (new `git.manage` permission): add repositories —
  HTTPS URL, default branch, folder, access token (encrypted, never shown
  again), and optionally **require a commit** before any migration runs.
- **Migrate → Commit to Git**: pick a branch or create one, write a note (the
  commit message), review the exact file, then Commit or Commit & push.
  **Execute** then runs the migration *from that commit*.
- **Applies → Git** (new `git.view` permission, granted once on upgrade to
  roles that can browse or compare schemas): fetch, pull and push; each
  migration marked applied or incoming for the connected target; review and
  run incoming ones from their commit.
- Migration files are plain SQL with the steps kept in comments, so Fox runs
  exactly what was reviewed. Passwords in account statements are replaced with
  `<password>`, and a file that still carries a credential is refused.
- Remotes are `https://` only; on a shared server, private and internal
  addresses are refused at connect time (including IPv6 spellings of them).

## Backup & Restore

**Utils → Backup & Restore** writes the engine's backup and restore commands
for the credential at the top of the workspace.

- The amber banner says where the command runs (your machine, the database
  server, or a cloud snapshot) — that is what the folder field means.
- Passwords stay out of the command. Folder / format / scope can be saved as
  *your default for this engine* (`GET` / `PUT /api/backup-settings`).
- SQL commands (SQL Server, CockroachDB, ClickHouse, DuckDB) open in the
  Editor; shell tools you copy.
- Where the backup is server-side SQL, **Run backup now** runs it after a
  confirmation (needs Change schema). SQL Server, Db2 and ClickHouse list the
  backups they recorded; pick one and the restore reads it. Restores still only
  open in the SQL Editor.

See [user-guide.md](../user-guide.md#utilities).

## Access: Grants show what is held

**Access → Permissions → Grants** opens on the privileges that principal
already holds. The SQL is only the difference (new ticks GRANT, cleared boxes
REVOKE). EXECUTE on procedures and functions is read too, so those rows open
ticked. Privileges the grid cannot show — CONNECT, schema USAGE, DENY — are
listed under it and not revoked as a side-effect of ticking one table. Permission **Diff** is a
separate tab (desired state vs catalog, including DENY).

## Sessions

A session unused for 8 hours ends (`FOX_SESSION_IDLE_HOURS`; `0` turns this
off), whatever its 7-day expiry. **Sign out other sessions** is on the profile
menu.

