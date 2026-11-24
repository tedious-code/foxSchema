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
repository `tedious-code/foxschema`, workflow `npm-publish.yml`, GitHub
environment **`npm-publish`**). The job must run in that environment
(`environment: npm-publish` in the workflow): npm only accepts the OIDC token
from it. Without that line `npm publish` fails with `ENEEDAUTH` (v0.3.1,
2026-11-08). The entry pins the workflow **filename** and that environment
name — renaming either breaks publishing until the Trusted Publisher entry is
updated. `ship-release.yml` publishes the same package and needs its own
entry.

Requires npm >= 11.5.1; the workflows install npm 11 before publishing. The
publish step uses `--loglevel verbose` so a refused OIDC exchange says why.

### Docker build context

`.dockerignore` **keeps `scripts/`** in the image build context.
`packages/shared` tests import `scripts/bundle`, `scripts/feature-map` and
`scripts/test-ids`, so excluding the folder fails the web build's typecheck
inside the image (`TS2307`) and the Docker release never ships. The runtime
stage does not copy `scripts/`. Do not add `scripts` to `.dockerignore`.

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

See [packaging/homebrew/README.md](../../packaging/homebrew/README.md).

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
npm run smoke:cli
```

`npm run smoke:cli` installs the packed CLI into a temp folder the way a user
does (`npm install -g`), starts it with `foxschema open` in a throwaway HOME,
and test-runs a workflow. Both release workflows run it before `npm publish`.
It catches what running from source cannot: in the repo, esbuild and every
dependency are present, so the server can quietly rebuild whatever the package
lacks. 0.3.34 shipped with a workflow engine that never started while every
test passed. It takes about 3 minutes, needs the network, and publishes nothing.

---

## Library packages (not published yet)

The engine is four workspace packages, published by hand when a release of them
is scheduled — never by the tag workflow above:

| Package | Staging | Depends on |
| --- | --- | --- |
| `@foxschema/sql` | `npm run publish:sql` | nothing |
| `@foxschema/db` | `npm run publish:db` | `@foxschema/sql` |
| `@foxschema/db-db2` | `npm run publish:db-db2` | `@foxschema/db`, `@foxschema/sql` (+ optional `ibm_db`) |
| `@foxschema/features` | `npm run publish:features` | `@foxschema/sql` — stays private until `PUBLISHABLE` is set in its staging script |

Each `publish:*` builds the package and writes `packages/<name>/npm-pack/`,
pinning workspace dependencies to the versions alongside. Before publishing any of
them, run the consumer smoke test, which installs the packed tarballs into an empty
project and uses them as an outsider would (needs the network for better-sqlite3):

```bash
npm run smoke:packed
```

Publish in dependency order — `sql`, then `db`, then `db-db2` (and `features`) —
because each staged manifest pins the one before it.

## UI bundles (Cloudflare R2)

`.github/workflows/ui-release.yml` publishes the frontend on its own, as a
signed bundle in a Cloudflare R2 bucket. Backends verify Ed25519 signatures and
SHA-256 pack hashes via `@foxschema/server` (`FOX_UI_UPDATES`, `FOX_UI_FEED_URL`,
`FOX_UI_PUBLIC_KEYS`), serve verified bundles from `startUiServer`, report the
active Web UI source on Home → Services, support `?ui=packaged`, and expose
`foxschema ui status|check|apply|reset` once at least one public signing key is
pinned in `UI_BUNDLE_PUBLIC_KEYS` (or `FOX_UI_PUBLIC_KEYS`).

### One-time setup

1. **Bucket.** Cloudflare dashboard → R2 → Create bucket, named `fox-ui` (or
   set the repository variable `R2_BUCKET` to your name).
2. **R2 API token.** R2 → Manage API tokens → Create, permission **Object Read
   & Write**, applied to that bucket only. Note the Access Key ID, the Secret
   Access Key and the account ID.
3. **Signing key.** On your own machine, never in CI:

   ```bash
   openssl genpkey -algorithm ed25519 -out fox-ui-signing.pem
   node scripts/ui-release/ui-release.mjs pubkey --key fox-ui-signing.pem
   ```

   The second command prints a line to add to `UI_BUNDLE_PUBLIC_KEYS` in
   `packages/shared/src/ui-bundle.ts`. Merge that to `main`: the workflow
   refuses to sign with a key that is not pinned there. Keep the `.pem` offline
   (a password manager); losing it means pinning a new key and shipping a
   backend release before UI releases can resume.
4. **GitHub environment.** Settings → Environments → New environment
   `ui-release`:
   - **Required reviewers:** yourself. Every signing run waits for your click.
   - **Deployment branches and tags:** `main` and tags `ui-v*` only.
   - **Secrets:** `UI_SIGNING_KEY` (the whole `.pem`), `R2_ACCOUNT_ID`,
     `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
5. **Public address: the Worker.** Backends read the bucket through a small
   read-only Worker on `workers.dev`, so no domain is needed (a custom domain
   on R2 would need foxschema.com's DNS moved to Cloudflare). From the
   repository root:

   ```bash
   npx wrangler@4 login
   npx wrangler@4 deploy --config scripts/ui-release/cdn-worker/wrangler.jsonc
   ```

   It is live at **`https://fox-ui.foxschema.workers.dev`** (deployed
   2026-11-22; `foxschema` is the account's workers.dev subdomain). Redeploy
   only when `cdn-worker/` changes. It
   serves only `channels/stable.json`, `releases/<version>/manifest.json` and
   `packs/<sha256>`, and accepts `POST /signup` (or `/api/signup`) to store
   user sign-ups privately under `signups/by-email/` in R2 (and optional KV/D1)
   while refusing public `GET` reads on `signups/*` (optional admin export via
   `GET /api/signups` requires `SIGNUP_ADMIN_TOKEN`). Keep the bucket's own
   `r2.dev` URL turned off.

   **Free-plan budget:** 100,000 Worker requests a day, cache hits included.
   A backend's channel check is one request and a UI update is two (manifest
   and pack), so this covers roughly 20,000 installs checking four times a
   day. Past that, Workers Paid is $5 a month for 10 million requests.

### Releasing

```bash
git tag ui-v0.3.25.1 && git push origin ui-v0.3.25.1
```

Or **Actions → UI Release → Run workflow** with a `version`. The run type-checks,
runs the unit tests, builds `apps/web`, then waits for approval before signing
and uploading. Each version can be published once.

- **What goes up:** one pack per release (every file end to end), the
  release's manifest, and the channel. The signature is inside each manifest
  and channel file, so each is one download.
- **Roll back:** Run workflow with `rollback_to: <version>`. The old pack is
  published again under a new sequence (backends refuse a lower one, by
  design), as `<version>-r<sequence>`.
- **Weekly re-sign:** a Monday schedule re-signs the channel so it does not
  expire (45 days). It needs the same approval; skipping a few weeks is fine.

To try the staging step locally without uploading anything:

```bash
npm run build -w @foxschema/web
UI_SIGNING_KEY="$(cat fox-ui-signing.pem)" node scripts/ui-release/ui-release.mjs stage --dist apps/web/dist --version 0.0.0-local --out /tmp/fox-ui
```
