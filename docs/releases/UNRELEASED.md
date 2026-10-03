# Unreleased

Notes for the next release. At ship time, rename this file to that version's
`RELEASE_<version>.md` and use it as the GitHub Release body.

## Workspaces

- **Snapshots** is its own left-rail workspace (schema history / Lokee). **Applies**
  at the bottom of the rail is migration-run history. They are not the same list.
- **Utils** is its own workspace (Index Management, Clone Table, insights, Query
  files, DB users & grants) — not a SQL Editor sidebar.
- Saved credentials are grouped by dialect; Home continues last compare / query.

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

