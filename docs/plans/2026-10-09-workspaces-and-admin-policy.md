# Workspaces and the admin policy — 2026-10-09

**Status: proposed.** Nothing is built yet. The decisions in the next section
need a yes before phase 1 starts.

## Summary

Two features that share one change to how accounts relate to data:

1. **Admin policy.** An admin chooses whether this install allows **one admin**
   or **several**. With "one", nobody can add a second admin or promote
   someone to admin while an active admin exists; handing the role over is an
   explicit **Transfer admin** step.
2. **Workspaces.** Connections and everything made from them (history,
   migration runs, secrets) belong to a workspace instead of to one account.
   - Every account gets its **own workspace** and can invite other people
     into it.
   - Admins can create **more workspaces** (a team, a project, an environment)
     and invite members.
   - Each workspace is **private** (invite only, hidden) or **public** (listed
     to every account, which can join without an invite).

## What exists today

| Fact | Where |
|---|---|
| Account roles are install-wide: `viewer`, `editor`, `owner`, `admin`. Every request gets the permissions of `users.app_role`. | `packages/shared/src/permissions.ts`, `attachAuthUser` in `packages/server/src/features/auth/auth.routes.ts` |
| Any number of admins. Adding or promoting an admin has no limit; only *demoting the last active admin* is refused. | `POST /users`, `PUT /users/:id/role` in `packages/server/src/features/admin/admin.routes.ts`; `setUserRole` in `features/authorization/rbac.service.ts` |
| Admins skip every permission check. | `denyUnless` in `features/authorization/rbac.guard.ts` |
| Data is private per account: queries filter on `user_id`. About 53 query sites across admin, auth, migration, history, data-migrate, connections, users, workflow and backup. | `grep -rn "user_id = ?" packages/server/src` |
| `connections.workspace_id` already exists, always `'local'`. Migration 17's comment says it was added so connections could "attach to real workspaces later without another connections DDL". | `packages/server/src/database/schema.ts` (migration 17) |
| `'local'` is also `COMMUNITY_WORKSPACE_ID` in the workflow contract, and `workflow_settings` is keyed by it. FoxAgent depends on this package. | `packages/workflow-contract/src/constants.ts` |
| Git repositories are install-wide, with their own role list (`git_repos.roles`). | `features/git` |
| No self-registration; SSO signs in existing accounts only. | `auth.service.ts` `loginWithEmail`, `auth.routes.ts` |
| Install settings are key/value rows, with env vars overriding them (pattern: `SignInSettings.broker()`). | `features/admin/app-settings.service.ts`, `features/auth/sign-in-settings.service.ts` |
| Latest metadata migration is **27**. Migrations are append-only and run on SQLite, Postgres and MySQL metadata stores (`types(d)`). | `packages/server/src/database/schema.ts` |

## Decisions to confirm

Each has a recommendation; the design below assumes it.

**D1. Default admin policy.** *Recommend:* new installs default to **one
admin**. On upgrade, an install with more than one active admin is set to
**several** so nobody loses access; an install with one admin is set to
**one**. `FOX_ADMIN_POLICY=one|several` overrides it, like the other sign-in
settings.

**D2. What "public" means.** *Recommend:* a public workspace is **listed to
every signed-in account**, and anyone can join it straight away with the
workspace's **join role** (default `viewer`). A private workspace is not
listed and is invite only. Personal workspaces are always private.

**D3. Who can create workspaces.** *Recommend:* admins always. Other accounts
only when the admin turns on **Members can create workspaces** (default off).
Every account still gets its own personal workspace automatically.

**D4. Inviting people who have no account.** *Recommend:* workspace owners
invite **existing accounts**. Inviting an email with no account creates one,
which today only an admin can do, so it stays admin-only unless the admin
turns on **Workspace owners can invite new people** (default off).

**D5. Account role versus workspace role.** *Recommend:* split the permission
keys in two (table below).
- **Install keys** come from the account role, which the admin sets: running
  server-side code, the workflow engine, Git repositories, user management.
- **Workspace keys** come from the role in the current workspace: everything
  done to a database.

On upgrade each account's role in its own workspace equals its old account
role, so nobody can do anything they could not do before. New accounts are
`owner` of their own workspace (an admin setting can lower that).

**D6. Admins and private workspaces.** *Recommend:* admins see every
workspace's name, visibility and members, and can change membership. They see
a private workspace's connections only as a member; adding themselves shows up
in the member list, so it is never silent.

**Kept as is in this plan:** Git repositories stay install-wide, and the
workflow engine keeps using workspace `'local'`. Moving either one is its own
follow-up (see *Out of scope*).

## Design

### 1. Admin policy

A setting `auth.admin_policy` = `one` | `several`, read through a new
`AdminPolicy` beside `SignInSettings`, with `FOX_ADMIN_POLICY` winning.

It is enforced in `RbacModule`, not only in routes, so the CLI, SSO and any
future caller hit the same rule:

```ts
// features/authorization/rbac.service.ts
async assertAdminSlotFree(exceptUserId?: string): Promise<void> {
  if ((await this.policy.adminPolicy()).value === 'several') return;
  const store = await getStore();
  const row = await store.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users
     WHERE app_role = 'admin' AND (active IS NULL OR active != 0) AND id != ?`,
    [exceptUserId ?? '']
  );
  if (Number(row?.n ?? 0) > 0) {
    throw new Error('This install allows one admin. Transfer the admin role instead.');
  }
}
```

It is called from three places:
- `setUserRole` when the new role is `admin`;
- `AuthModule.insertUser` when the role is `admin`;
- `setUserActive(id, true)` for an inactive admin, because reactivating one
  would otherwise make two.

First-run setup creates the first admin and is not affected.

**Transfer admin** (`POST /api/admin/users/:id/transfer-admin`) promotes the
target and demotes the caller in **one transaction**, to `owner` by default.
Only the current admin can call it.

**Switching from several to one** is refused while more than one active admin
exists, and the error names them: "Make Ana and Ben non-admins first." The
alternative, keeping existing extra admins and only blocking new ones, leaves
an install that says "one" while it has three.

Admin screen: **Admin → Access control → Users** gets an **Admins: One /
Several** control, with the env-locked state shown the way the Sign-in tab
already shows one.

### 2. Data model

Migration **28** adds the tables; migration **29** adds the columns. The
backfill (section 9) runs in code after both.

```ts
{
  id: 28,
  name: 'workspaces',
  statements: (d) => {
    const t = types(d);
    return [
      `CREATE TABLE IF NOT EXISTS workspaces (
         id ${t.id} PRIMARY KEY,
         name ${t.str} NOT NULL,
         visibility ${t.str} NOT NULL DEFAULT 'private',   -- 'private' | 'public'
         join_role ${t.str} NOT NULL DEFAULT 'viewer',     -- role a public join gets
         personal_owner_id ${t.id},                        -- set only on personal workspaces
         created_by ${t.id},
         created_at ${t.ts} NOT NULL,
         archived_at ${t.ts}
       )`,
      `CREATE TABLE IF NOT EXISTS workspace_members (
         workspace_id ${t.id} NOT NULL,
         user_id ${t.id} NOT NULL,
         role ${t.str} NOT NULL,                           -- 'viewer' | 'editor' | 'owner'
         added_by ${t.id},
         created_at ${t.ts} NOT NULL,
         PRIMARY KEY (workspace_id, user_id)
       )`,
      `CREATE TABLE IF NOT EXISTS workspace_invites (
         id ${t.id} PRIMARY KEY,
         workspace_id ${t.id} NOT NULL,
         user_id ${t.id},                                  -- null until an account exists
         email ${t.str} NOT NULL,
         role ${t.str} NOT NULL,
         invited_by ${t.id} NOT NULL,
         created_at ${t.ts} NOT NULL,
         expires_at ${t.ts} NOT NULL,
         accepted_at ${t.ts},
         declined_at ${t.ts}
       )`,
    ];
  },
},
{
  id: 29,
  name: 'workspace_ownership',
  statements: (d) => {
    const t = types(d);
    return [
      // connections.workspace_id exists since 17 (default 'local').
      `ALTER TABLE app_secrets ADD COLUMN workspace_id ${t.str}`,
      `ALTER TABLE cloud_provider_credentials ADD COLUMN workspace_id ${t.str}`,
      `ALTER TABLE lokee_databases ADD COLUMN workspace_id ${t.str}`,
      `ALTER TABLE migration_runs ADD COLUMN workspace_id ${t.str}`,
      `ALTER TABLE data_migrate_runs ADD COLUMN workspace_id ${t.str}`,
      `ALTER TABLE user_preferences ADD COLUMN last_workspace_id ${t.str}`,
    ];
  },
},
```

`user_id` stays on every table and from now on means **who made it**, which
the UI shows ("added by Ana"). Workspace is a separate column, so a
connection moved between workspaces keeps its author.

Workspace roles reuse `viewer` / `editor` / `owner`, so the existing role
matrix (`role_permissions`) still defines what each one can do. `admin` is an
account role only, never a workspace role.

### 3. What belongs to a workspace

| Belongs to the workspace | Stays with the account | Stays install-wide |
|---|---|---|
| connections, secrets, cloud provider credentials, schema history (Lokee), migration runs, data-migrate runs | sessions, sign-in codes, preferences (theme, last workspace), backup defaults (`backup_settings`, keyed by user) | users, role matrix, sign-in settings, Git repositories, workflow settings |

**Sharing a connection shares its stored password.** Members use it on the
server and never see it (the server never returns passwords, as today).
- Fox's roles limit what a member can do, for example a viewer cannot run DDL.
- The database account limits what is possible at all.

The workspace screen says this next to **Invite**.

### 4. Roles and permissions

Each permission key is one of two kinds. A request's permissions are the
**install keys** of the account role plus the **workspace keys** of the
member's role in the current workspace.

| Kind | Keys | Comes from |
|---|---|---|
| Install | `editor.advanced` (runs code on the server), `workflow.*`, `git.*`, `admin.*`, new `workspace.create` | account role (`users.app_role`) |
| Workspace | `schema.*`, `compare.history`, `editor.*` except `editor.advanced`, `utility.*`, `secrets.*`, `access.*`, new `workspace.members`, `workspace.settings` | role in the current workspace |

`editor.advanced` must stay an install key. It runs JS/TS on the server, so
making someone `owner` of their own workspace must not give them server code
execution.

New keys:
- `workspace.members`: invite, remove, change roles. Default: `owner`.
- `workspace.settings`: rename, visibility, join role, archive. Default:
  `owner`.
- `workspace.create`: create more workspaces. Default: admin only. The
  **Members can create workspaces** setting grants it to every account
  (decision D3).

They go into `PERMISSIONS` / `PERMISSION_META`, and a one-time grant gives
`owner` the two workspace keys, using the existing `applyOneTimeGrants`
pattern in `rbac.service.ts`.

```ts
// packages/shared/src/permissions.ts
export const INSTALL_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'editor.advanced', 'workflow.access', 'workflow.design', 'workflow.run', 'workflow.admin',
  'git.view', 'git.manage', 'admin.users', 'admin.roles', 'workspace.create',
]);

export function effectivePermissions(
  accountRolePerms: Iterable<Permission>,
  workspaceRolePerms: Iterable<Permission>
): Set<Permission> {
  const out = new Set<Permission>();
  for (const p of accountRolePerms) if (INSTALL_PERMISSIONS.has(p)) out.add(p);
  for (const p of workspaceRolePerms) if (!INSTALL_PERMISSIONS.has(p)) out.add(p);
  return out;
}
```

**Admins.** `denyUnless` keeps letting admins through for install keys. For
workspace keys an admin needs to be a member (decision D6). That is one
condition in `denyUnless`, and it is covered by a test for each of the two
paths.

### 5. The current workspace on each request

- The browser sends `X-Fox-Workspace: <id>` on every API call, from the
  shared client (`apps/web/src/frontend/shared/api/client.ts`).
- Without the header, the server uses `user_preferences.last_workspace_id`,
  then the personal workspace. So the CLI, old tabs and tests keep working.
- `attachAuthUser` resolves membership once per request:

```ts
// features/auth/auth.routes.ts
export async function attachAuthUser(user: AuthUser, req: AuthedRequest, launchSession = false) {
  req.userId = user.id;
  req.appRole = user.role;
  const ws = await workspaces.resolveForRequest(user, headerValue(req, 'x-fox-workspace'));
  req.workspaceId = ws.id;                 // always set: personal workspace at worst
  req.workspaceRole = ws.role;             // null for an admin who is not a member
  req.permissions = effectivePermissions(user.permissions, await rbac.permissionsForRole(ws.role));
  req.launchSession = launchSession;
}
```

`resolveForRequest` refuses a workspace the account is not a member of. It
answers **404, not 403**, so a private workspace's id is not confirmed to
exist.

Every `WHERE user_id = ?` on a workspace-owned table becomes
`WHERE workspace_id = ?`, using `req.workspaceId`. One example:

```ts
// features/connections/connection-store.service.ts
async list(workspaceId: string): Promise<SavedConnectionSummary[]> {
  const rows = await store.all<ConnectionRow>(
    `SELECT id, name, dialect, "schema", encrypted_config, created_at, user_id
     FROM connections WHERE workspace_id = ? ORDER BY created_at DESC`,
    [workspaceId]
  );
  return rows.map((r) => this.toSummary(r));
}
```

**Follow every query that takes an id**, for example `resolve(userId, id)`.
Those must check `workspace_id` too, or anyone could open a connection in a
workspace they have left by its id. Phase 2 has a test that tries every such
route with an id from another workspace.

### 6. Visibility and joining

- **Private:** only members and admins see it. People get in only by invite.
- **Public:** `GET /api/workspaces/discover` lists it to every signed-in
  account (name, member count, join role). **Join** adds the caller with the
  join role.
- Changing public → private keeps current members and hides it from
  everyone else.
- Personal workspaces cannot be made public, because that would publish an
  account's own connections.

### 7. Invitations

- An owner (`workspace.members`) invites by email with a role.
- **The email has an account:** the invite appears in that person's
  workspace switcher under **Invitations** with Accept / Decline. If SMTP is
  configured it is also emailed, through `AuthMailer` as invites are today.
  Accepting adds the member. Invites expire after 14 days.
- **The email has no account:** only allowed when decision D4's setting is
  on, or the inviter is an admin. Fox creates the account the way
  `inviteUser` does today, with account role `viewer`, and the workspace
  invite waits for its first sign-in. Google and GitHub sign-in then work for
  that email.
- **Invites ask; they do not add.** Nobody lands in a workspace they did not
  accept. Admins can still add a member directly from the admin screen.
- **Last-owner guard:** removing or demoting the last owner of a workspace is
  refused, the same rule as the last active admin. Leaving works the same way.

### 8. Personal workspaces

- Fox creates one when an account is created. That covers `insertUser`,
  first-run setup and the launch-session owner.
- It is named after the email ("huyplb's workspace"). The owner can rename it.
- It cannot be archived, and cannot be made public.
- When an account is deactivated, its personal workspace stays and its other
  members keep access. An admin can transfer ownership or archive it.

### 9. Upgrade: existing data

A backfill runs once after migration 29. It is idempotent and guarded by an
`app_settings` flag, like `backfillDatagridRolePermissions`. It runs in code
rather than SQL because the metadata store can be SQLite, Postgres or MySQL,
which generate ids differently.

1. For each user: create the personal workspace, and add the user as a
   member with **role = their current account role**, capped at `owner`. An
   admin becomes `owner` of their own workspace.
2. Move every row with that `user_id` into that workspace, on all six
   workspace-owned tables (section 3).
3. Set `auth.admin_policy` per decision D1.

After the upgrade everyone sees exactly what they saw before (their own
data), with the same permissions. Nothing is shared until someone invites
someone.

**Your dev database** has 5 admins (`you@company.com`,
`e2e-admin@foxschema.test`, `yoy@company.com`, `huy.ph1988@gmail.com`,
`huyplb@live.com`), so D1 would set it to **several**. The e2e suite signs in
as `e2e-admin`, which keeps working.

### 10. UI

- **Workspace switcher** at the top of the sidebar: current workspace,
  others, **Invitations**, **Browse public workspaces**, **New workspace**
  (when `workspace.create`). It is hidden while an account has one workspace
  and no invites, so personal and desktop installs look as they do now.
- **Workspace settings** (`workspace.settings` / `workspace.members`):
  - name;
  - visibility, Private / Public, with join role;
  - members, showing role and who added them;
  - pending invites, with resend and revoke;
  - leave, and archive.
- **Admin → Access control → Workspaces** (new tab): every workspace, with
  owner, visibility, member count and archived state. Actions: create,
  transfer ownership, archive, add member. Also the two policy switches,
  **Members can create workspaces** and **Workspace owners can invite new
  people**.
- **Admin → Access control → Users:** the **Admins: One / Several** control
  and **Transfer admin**.
- Each saved connection shows who added it.
- Every new control gets a test ID in the catalog (`npm run test-ids`).

### 11. API

| Method | Path | Needs |
|---|---|---|
| GET | `/api/workspaces` | signed in (own memberships) |
| POST | `/api/workspaces` | `workspace.create` |
| GET | `/api/workspaces/discover` | signed in |
| POST | `/api/workspaces/:id/join` | signed in, public workspace |
| PATCH | `/api/workspaces/:id` | `workspace.settings` |
| POST | `/api/workspaces/:id/archive` | `workspace.settings`, not personal |
| GET / PUT / DELETE | `/api/workspaces/:id/members[/:userId]` | `workspace.members` (GET: member) |
| POST | `/api/workspaces/:id/invites` | `workspace.members` |
| DELETE | `/api/workspaces/:id/invites/:inviteId` | `workspace.members` |
| GET | `/api/me/invites` | signed in |
| POST | `/api/me/invites/:id/accept`, `/decline` | the invitee |
| GET / PUT | `/api/admin/workspaces[...]` | `admin.users` |
| GET / PUT | `/api/admin/policy` | `admin.users` |
| POST | `/api/admin/users/:id/transfer-admin` | the current admin |

Bodyless POSTs (join, archive, accept, decline) go through the shared API
client. A bodyless request sent with a JSON `Content-Type` is rejected with
400 before it reaches the route; that broke logout and three deletes before.

## Phases

Each phase is one PR to `main`, and each leaves the app working.

1. **Admin policy.** It is independent of workspaces and the smallest change:
   setting, `assertAdminSlotFree` at its three call sites, Transfer admin, the
   Users-tab control, and the upgrade default (D1). It can ship before
   workspaces are agreed.
2. **Workspaces underneath, no visible change.** Migrations 28–29 and the
   backfill; `req.workspaceId`; every workspace-owned query switches to
   `workspace_id`; personal workspace on account creation; the permission
   split. Every user still sees only their own data. This is the large,
   risky PR: about 53 query sites.
3. **Shared workspaces.** Create, members, invites, switcher, workspace
   settings, private only.
4. **Public workspaces and admin tools.** Discover and join, join role, Admin
   → Workspaces tab, the two policy switches (D3, D4), invite email.

## Tests

- **Unit (`packages/shared`):**
  - `effectivePermissions`: an install key never comes from a workspace
    role, and a workspace key never comes from an account role.
  - Every key in `PERMISSIONS` is classified.
- **Server:**
  - Admin policy: add, promote and reactivate are each refused under "one";
    Transfer admin is atomic; switching to "one" is refused with several
    admins.
  - Cross-workspace isolation: for **every** route that takes an id, an id
    from another workspace returns 404. This is table-driven over the route
    list, so a new route without a check fails the test.
  - Last-owner guard; invite expiry; public join gets the join role; private
    workspaces are absent from discover.
  - Backfill: each user's rows land in their workspace, the role is kept, a
    second run changes nothing. Run it on SQLite, and on Postgres/MySQL
    metadata when `FOX_IT_DB=1`.
- **Migrations:** 28 and 29 are append-only additions; the naming and schema
  tests pass.
- **Component:** the switcher hides with one workspace; Workspace settings
  and the Admin tab, with test IDs.
- **E2E:**
  - Two accounts; A invites B, B accepts, B sees A's connection but not A's
    personal one.
  - A makes the workspace public; C finds it and joins as viewer, and cannot
    run DDL.

## Risks

- **Missed `user_id` filter → data leak.** Phase 2's isolation test is the
  guard. It must enumerate routes from the router, not from a hand-kept list.
- **FoxAgent.** It depends on `@foxschema/workflow-contract`, and its CI
  checks out foxSchema unpinned. This plan does not touch the contract or the
  `'local'` workflow workspace, so FoxAgent sees no change. Any later move of
  workflows into workspaces must be coordinated with that repo.
- **Admin bypass.** Admins skip permission checks today. Narrowing it for
  workspace keys (D6) changes behavior for every admin; the release notes
  must say so.
- **Shared credentials.** Section 3. The invite dialog says it, and the role
  matrix already keeps `editor.grant` and `schema.migrate` off `editor`.

## Out of scope

- Git repositories per workspace (they keep `git_repos.roles`).
- Workflows per workspace (`'local'` stays).
- Moving a connection between workspaces. Later; needs `workspace.members`
  on both sides.
- Audit log of membership changes, beyond who-added-whom on each member.
- Billing, quotas or per-workspace sign-in settings.
