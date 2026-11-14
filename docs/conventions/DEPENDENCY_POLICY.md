# Dependency policy

How this repository defends against a compromised npm package.

The threat is ordinary: an attacker takes over a package — often a small
transitive one — and publishes a patch release containing a credential stealer
or a build-time backdoor. Nothing about that release looks unusual, and semver
ranges install it automatically.

## What is in place

### The lockfile is committed

`package-lock.json` is tracked. It is the only thing that pins **transitive**
dependencies; `package.json` pins only the direct ones. Without it, every
install resolves fresh and a compromised release published an hour ago is
installed on the next CI run.

This was the intent for a long time without being the state. `.gitignore`
carried `package-lock.json` on line 10 and, directly beneath it, the comment
*"package-lock.json is committed on purpose"* — the comment was added and the
ignore line above it was never removed, so the policy this document described
had simply never taken effect. Corrected 2026-09-21: the ignore line is gone,
the lockfile is regenerated and committed, and CI installs with `npm ci`.

What that cost while it was untracked is worth keeping, because the symptom was
confusing on its own: `package.json` carried `overrides: { "adm-zip": "0.6.1" }`
to clear three advisories in the `ibm_db` -> `adm-zip` chain, the override was
correct, and it did nothing — the stale untracked lockfile on each machine
pinned `adm-zip` to `0.5.18` and npm honoured it. The override only took effect
once the lockfile was regenerated from a clean resolve. An override you cannot
see the effect of is worse than no override.

### CI installs with `--ignore-scripts`

`preinstall` / `postinstall` hooks never run in CI. Those hooks are the usual
payload location, and they execute before any test or scan sees the code.

This includes the publish and release workflows, which hold an npm token and
are therefore the worst place to run code a dependency chose. `build-gate`
builds the same artifacts with `--ignore-scripts`, so nothing needs them.

### `npm ci`, and the cross-platform problem that used to block it

CI installs with `npm ci --ignore-scripts`. It installs exactly the locked tree
and fails when the lockfile and `package.json` disagree, which is the property
that makes a committed lockfile worth having.

This section used to say `npm ci` could not be used, for a real reason worth
keeping: npm records a lockfile entry only for the platform binaries it actually
resolved (npm/cli#4828). A lockfile generated on macOS had
`@tailwindcss/oxide-darwin-arm64` and no `@tailwindcss/oxide-linux-x64-gnu`, and
a Linux runner then failed with "Cannot find native binding" — under
`npm install` as well as `npm ci`, because npm trusts the lockfile and skips the
binary it does not find listed. Twenty-nine entries were added from the registry
by hand to work around it, and the two platforms pruned each other's entries on
every install.

**On npm 11 this no longer reproduces.** A from-scratch resolve on macOS
(`rm -rf node_modules package-lock.json && npm install`) now records every
platform of every native package:

| Package family | Platforms recorded |
|---|---|
| `@tailwindcss/oxide` | android, darwin, freebsd, linux, win32 |
| `@duckdb/node-bindings` | darwin, linux, win32 |
| `@napi-rs/keyring` | darwin, freebsd, linux, win32 |
| `@rolldown/binding` | android, darwin, freebsd, linux, win32 |
| `lightningcss` | android, darwin, freebsd, linux, win32 |

Sixty native entries, up from twenty-five, with no hand editing. The
`edgesOut` crash that made a from-scratch resolve impossible was seen on npm 10
and npm 12; the repo pins npm 11 (`packageManager`), where it does not occur.

Two things this does *not* prove, and which are worth checking the first time CI
runs on it: that a Linux runner is happy with a macOS-generated lockfile in
practice, and that the release workflows behave. If a native binding goes
missing on Linux again, this section is the history of why, and regenerating the
lockfile on a Linux runner remains the fallback.

**Regenerating it.** `npm install --package-lock-only` reads any existing
`node_modules` and will reproduce whatever is already there — which is how the
`adm-zip` override stayed invisible. Remove both first:

```bash
rm -rf node_modules package-lock.json
npm install
npm ls adm-zip && npm audit --audit-level=high
```

### Every version is exact

No `^` or `~` in any `package.json`, including `overrides`. A dependency change
is a visible edit in a diff rather than a range that quietly widens. `.npmrc`
sets `save-exact=true` so `npm install <pkg>` keeps it that way.

Workspace links (`"@foxschema/sql": "*"`) are left alone — they resolve to the
local package, never to the registry.

### CI checks, in `dependency-security.yml`

| Check | Answers |
|---|---|
| `npm audit signatures` | Is this tarball the one the registry published? Catches tampering and re-publishing. |
| `npm audit --audit-level=critical` | Is this version known to be vulnerable? Fails the build. |
| `npm audit --audit-level=high` | Same, as a warning. |
| ESLint security rules | Does our own code do something unsafe? |
| `deps-backdoor-scan` | Does anything in `node_modules` open a port or shell out? Runs weekly as well as per-PR, to catch a delayed publish. |

## Upgrading a dependency

1. `npm install <pkg>@<exact-version>` — `.npmrc` writes the exact version.
2. Commit `package.json` **and** `package-lock.json` together, so the tree that
   was reviewed is the one recorded.
3. Read what changed. For a package you have not upgraded in a while, the
   release notes and the diff matter more than the version number.

Prefer waiting a few days after a release before taking it, unless it fixes
something that affects this project. Most malicious publishes are found and
unpublished within a day or two.

## Known exception: monaco-editor

`npm audit` reports four `dompurify` advisories reached through
`monaco-editor`, and offers to fix them with `npm audit fix --force`.

**Do not run that here.** It installs `monaco-editor@0.56.0`, which breaks the
frontend build — the root `overrides` pin `monaco-editor` to `0.55.1` for that
reason.

This is accepted risk, not a resolved issue. The advisories concern DOMPurify's
`IN_PLACE` and hook-configuration modes; whether any of them is reachable
through the editor as this application uses it has not been established either
way. Revisit when a monaco release ships a patched DOMPurify, or establish
reachability if the advisories escalate.
