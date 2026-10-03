# Migrations in Git — 2026-10-02

## Summary

Put every migration Fox runs into a real Git repository, so a team reviews
schema changes where it already reviews code:

- **Review → commit → run.** The generated migration script is committed to a
  branch, with a note as the commit message, before it runs. Running it records
  which commit was applied.
- **Branches.** Pick an existing branch or create one from the default branch.
- **Fetch, pull, push** to GitHub, GitLab, Bitbucket, Azure DevOps or any Git
  host over HTTPS with an access token.
- **Pull brings teammates' migrations in**: Fox lists the scripts on the branch
  that have not been applied to the chosen target, to review and run.

Decisions (2026-10-02):

| Question | Decision |
|---|---|
| What "mini git" is | A real Git repo, built in (isomorphic-git), so no `git` binary is needed — the Docker image has none |
| What a commit holds | The migration script only, one `.sql` file per migration; the note is the commit message |
| When it is committed | Before it runs: review → commit (→ push for review) → run |
| Remote auth | HTTPS + personal access token, stored encrypted; no SSH |

## What exists today

- `POST /api/migration/execute` streams a migration; `migration_runs` keeps the
  script, the target, per-object results (Applies on the rail).
- Lokee (schema history) versions schemas and reverts; it has no branches,
  remotes or notes and is not changed by this plan.

## Model

### Repositories (metadata migration 21, append-only)

```
git_repos
  id, name, remote_url (https only), default_branch,
  folder               -- where scripts live in the repo, default "migrations/"
  encrypted_token      -- encryptSecret(); never returned by the API
  author_name, author_email (optional committer override)
  created_by, created_at, updated_at

migration_runs  (+ columns)
  git_repo_id, git_branch, git_commit, git_path   -- what was applied
```

A repository is configured once per install by someone with the new
`git.manage` permission (admins by default). Committing and pushing need
`schema.migrate`, as running does today. Viewing history needs `schema.browse`.

### The working copy

One clone per repository under the app data directory
(`<data>/git/<repo-id>`), shared by every user of the install. Every operation
on a repository takes a per-repository lock (fetch, checkout, commit, push are
serialised), so two people committing at once cannot interleave a checkout.
Commits use the Fox user as author (`name <email>`).

### A migration file

```
migrations/20261002-153012__add-orders-index.sql
```

`<UTC timestamp>__<slug from the note>.sql`, so files never collide and sort in
the order they were written. The file starts with a header Fox reads back on
pull:

```sql
-- fox:migration v1
-- dialect: postgres
-- target: app_db.public           (host is not written: it is environment-specific)
-- source: staging_db.public
-- author: ana@example.com
-- note: Add the orders index the reports need
```

followed by the script exactly as Fox generated it.

**Secrets never go into a commit.** Scripts can carry password literals
(Database Access: `CREATE ROLE … PASSWORD '…'`). Before committing, Fox
replaces password literals with the dialect's placeholder and refuses the
commit if anything that looks like a credential remains, naming the line.

## Flows

### Migrate (Compare → plan → **Version control** → Execute)

The Migrate panel gains a Version control section when a repository is
configured:

1. **Repository** and **branch**: pick a branch, or *New branch* from the
   default branch (name validated against Git's ref rules).
2. **Review**: the file that will be added, its path and full contents, and
   the branch's state (up to date / behind *n* — pull first).
3. **Note** (required): first line becomes the commit subject.
4. **Commit**, or **Commit & push**.
5. **Execute** runs the committed script. The run records repo, branch,
   commit and path; Applies shows the commit and links to it on the host.

Executing without committing stays possible when no repository is configured.
When one is, an admin can make the commit step required
(`git_repos.require_commit`), so nothing reaches a database without a reviewed
commit.

### Branch view (new, under Applies)

- **Fetch**: update remote branches; show ahead / behind.
- **Pull**: fast-forward, or a merge commit when histories diverged. Migration
  files are new files with unique names, so real conflicts are rare; when one
  happens Fox stops and names the file — it never resolves a conflict itself.
- **Push**: push the branch; a rejected push says "pull first".
- **Incoming migrations**: scripts on the branch with no successful run against
  the chosen target, oldest first, each with its note, author and full script
  to review, and **Run** (through the existing execute path and its safety
  gates).
- **Log**: commits on the branch with their notes and whether/where each was
  applied.

## API

```
GET    /api/git/repos                       list (no tokens)
POST   /api/git/repos                       add (git.manage) — clones
PUT    /api/git/repos/:id                   edit; empty token keeps the stored one
DELETE /api/git/repos/:id                   remove (and its working copy)

GET    /api/git/repos/:id/branches          local + remote, ahead/behind
POST   /api/git/repos/:id/branches          create { name, from }
POST   /api/git/repos/:id/fetch
POST   /api/git/repos/:id/pull              { branch }
POST   /api/git/repos/:id/push              { branch }
GET    /api/git/repos/:id/log?branch=       commits + notes + applied runs
GET    /api/git/repos/:id/incoming?branch=&connectionId=
POST   /api/git/repos/:id/preview           { script, note, …} → path + file text (review)
POST   /api/git/repos/:id/commit            { branch, script, note, dialect, … } → commit
```

`POST /api/migration/execute` accepts an optional `{ gitRepoId, gitCommit,
gitPath }` and refuses when the script does not match the file at that commit.

## Security

- Remotes are `https://` only (no `http://`, `file://`, `ssh://`, `git://`).
  On a shared server (`LOCAL_SINGLE_USER=false`) private and loopback hosts are
  refused, as connection tests already are, so a repository URL cannot probe
  the internal network.
- Tokens are encrypted with the install key, sent only to the remote as HTTPS
  basic auth, never logged (the request-URL redaction from #448 plus the logger
  redact paths), never returned.
- Password literals are scrubbed from scripts before commit; a commit with a
  credential left in it is refused.
- Size and time limits on fetch/clone; a repository bigger than the limit is
  refused with a clear message.
- The per-repository lock also bounds concurrent network operations.

## Delivery — four PRs, each tested and merged before the next

1. **Git core** (server): isomorphic-git, `git_repos` + migration 21, the
   working copy and lock, branches / fetch / pull / push / log, token
   encryption, URL policy. Tests run against a real smart-HTTP Git server
   started in the test (`git http-backend` behind a token check), so fetch,
   push, non-fast-forward and bad-token paths are exercised for real.
2. **Commit & run**: file naming, header, secret scrubbing, preview/commit,
   execute linked to a commit, `incoming`. Tests: scrubbing per dialect, a
   commit → run → incoming-empty round trip, script/commit mismatch refused.
3. **UI**: Git settings (Admin), Version control section in Migrate, branch
   view with fetch/pull/push, incoming and log. Component tests for each.
4. **End to end + docs**: Playwright on SQLite — compare, commit to a new
   branch, push, then in a second clone pull and run the incoming migration;
   USER_GUIDE, DEPLOYMENT, release notes.

Each PR: typecheck, lint, lint:security, full unit suite, a code review pass,
CI green, then merge.

## New dependency

`isomorphic-git` (MIT, pure JavaScript, 11 small dependencies), pinned exactly
per the dependency policy, server-side only (`packages/server`).

## Not in scope

SSH remotes; schema files per object (decided: script only); editing a
migration after commit (a new commit is the fix); Lokee branches.
