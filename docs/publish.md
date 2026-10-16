# Publishing Fox Schema

How maintainers ship a release. **Users** should follow [install.md](install.md).

Distribution channels (one product, no separate Db2 edition):

| Channel | Artifact | Trigger |
|---------|----------|---------|
| **npm** | `foxschema` on registry.npmjs.org | `.github/workflows/npm-publish.yml` on `v*` tag |
| **Docker** | `5nickels/foxschema:latest` + `:vX.Y.Z` (linux/amd64, includes Db2) | `.github/workflows/web-release.yml` on `v*` tag |
| **Homebrew** | `Formula/foxschema.rb` in this repo | Manual commit after npm publish |
| **Winget** | **Retired** — do not publish | — |

Patch versions are bumped automatically on merge to `main`
(`.github/workflows/version-bump.yml`). For a **minor/major** release (e.g. `0.2.0`
SQL Editor), set the version in a `chore: release 0.2.0` commit so the auto-bump
is skipped, merge, then tag.

Demo GIFs for README / npm / docs: `docs/demo/*.gif` (Schema Sync + SQL Editor).

---

## 1. Merge to `main`

- Patch: CI bumps `0.2.N` → `0.2.N+1` after ordinary merges.
- Minor/major: merge a PR that already sets `0.2.0` with message
  `chore: release 0.2.0` (or include `[no bump]`).

---

## 2. Tag the release

Tag the commit that has the version you want to publish:

```bash
git fetch origin main
git checkout main && git pull
# package.json should show e.g. 0.2.0
git tag v0.2.0
git push origin v0.2.0
```

That starts:

- **Web Release** → Docker Hub + GHCR (`latest` and `v0.2.0`)
- **npm Publish** → no secret; authenticates by OIDC (npm Trusted Publishing)

If a tag push does not start those workflows (some bot pushes are ignored),
use **Ship Release** (`.github/workflows/ship-release.yml`):

```bash
# Preferred: publish/edit a GitHub Release for the tag, or:
gh api -X POST repos/tedious-code/foxschema/dispatches \
  -f event_type=ship-release \
  -f 'client_payload[tag]=v0.2.0'
```

The npm package ships with:

- Rich README (SQL Editor + Schema Sync GIFs via raw GitHub URLs)
- `"type": "module"` + `types` / `exports` so npm shows TypeScript + ESM
- `LICENSE` + `NOTICE`

Or run manually:

```bash
gh workflow run web-release.yml --ref v0.2.0
gh workflow run npm-publish.yml --ref v0.2.0
# or: gh release create v0.2.0 --generate-notes
```

### npm auth — Trusted Publishing, no secret

`npm publish` authenticates over OIDC: GitHub signs a token describing this
repository and workflow, and npm exchanges it for publish rights. Nothing is
stored, so nothing expires or leaks, and account 2FA does not block CI the way
it blocks a granular token.

Registered once on npmjs.com (package `foxschema` → Trusted Publisher →
repository `tedious-code/foxschema`, workflow `npm-publish.yml`). The entry
pins the workflow **filename** — renaming `npm-publish.yml` breaks publishing
until the entry is updated. `ship-release.yml` publishes the same package and
needs its own entry.

Requires npm >= 11.5.1; the workflows install npm 11 before publishing.

### Secrets

| Secret | Used by |
|--------|---------|
| `DOCKERHUB_USERNAME` | Docker Hub push (`5nickels`) |
| `DOCKERHUB_TOKEN` | Docker Hub access token (read/write) |

---

## 3. Homebrew (same repo)

After npm shows `foxschema@VERSION`, update the formula in this repo and push:

```bash
./packaging/homebrew/update-formula.sh 0.2.0
git add Formula/foxschema.rb
git commit -m "brew: foxschema 0.2.0"
git push origin main
```

Users install with:

```bash
brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
brew trust tedious-code/foxschema
brew install foxschema
```

See [packaging/homebrew/README.md](../packaging/homebrew/README.md).

---

## 4. Verify

```bash
npm view foxschema version
npm view foxschema types
npm view foxschema type
docker pull 5nickels/foxschema:latest
npm install -g foxschema@latest
foxschema doctor
foxschema shortcut
```

### In-app update toast + What's new

After publish, installed CLIs check
`https://registry.npmjs.org/foxschema/latest` on UI boot (and from
**User Preference → Check**). When npm `latest` is newer than the running
`APP_VERSION`:

- **What's new** opens the GitHub Release page
  `https://github.com/tedious-code/foxschema/releases/tag/vX.Y.Z`
  (body = `docs/releases/RELEASE_X.Y.Z.md` from `gh release create --notes-file`).
- **Local CLI (`foxschema open`)** — toast / Settings offer **Update now**, which
  runs `npm install -g foxschema@latest` and relaunches the UI (no terminal).
- **Docker / locked-down hosts** — toast offers **Copy command** instead
  (`npm install -g foxschema@latest`).

Always create the GitHub Release with the RELEASE notes file in the same ship
step as the npm tag, so the toast link is not a 404.

No extra feed hosting is required for the npm channel. Override with
`UPDATE_FEED_URL` only if you need a custom/GitHub feed; set `off` to disable.
Set `FOXSCHEMA_SELF_UPDATE=false` to force the copy-command path.

---

## 5. What not to publish

- Do **not** publish to Winget (retired).
- Do **not** publish separate `db2-latest` / `FoxSchema.DB2` packages.

---

## Local dry-run (before tagging)

```bash
npm run build -w @foxschema/web
npm run build -w @foxschema/cli
node apps/cli/scripts/prepare-publish.mjs
# inspect apps/cli/npm-pack/ — do not npm publish unless intentional
```
