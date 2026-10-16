# Fox Schema 0.2.16

Ship cut for **npm · Docker · Homebrew**. Covers everything since **`v0.2.10`**
(current public Latest). Intermediate `0.2.11`–`0.2.15` were auto-bumps on `main`.

## Highlights

- **Stale UI auto-restart** — after `npm i -g` / brew upgrade, `foxschema open`
  detects an old process still bound to the port (missing
  `/api/files/imports`, `/api/schema/dba-utility`, or index APIs, or a version
  mismatch) and relaunches. Stops the Express HTML `Cannot POST …` / Query-files
  404 class of upgrade failures. Public `GET /api/health` now includes `version`.
- **RBAC** — new **owner** role; `editor.write` split into **dml / ddl / grant**
  permissions (#154). Viewer write bypasses closed; `editor.write` gate fails
  closed (#152, #153).
- **Deps backdoor scan** — CI scans `node_modules` (install with
  `--ignore-scripts`) for dangerous lifecycle scripts, Phantom-Gyp
  `binding.gyp` payloads, worm IOC files, reverse shells, and unexpected
  `createServer` / `.listen` outside an allowlist. Weekly Sat **02:30 UTC**;
  also wired into Dependency Security + Release Gate (#155). Nested packages
  are attributed correctly.
- Clearer UI errors when a Files / schema API 404s because the server is stale.

## Seamless upgrade (from 0.2.10)

1. Keep the Docker `/data` volume (or metadata DB path) and a stable
   `APP_ENCRYPTION_KEY`.
2. Update, then run:

   ```bash
   foxschema stop && foxschema open
   ```

   On **0.2.16+**, `foxschema open` usually restarts a stale server for you;
   `stop` first is still the safe recovery if anything looks stuck.
3. No credential re-entry when the encryption key is unchanged.

## Distribution

| Channel | Artifact |
|---------|----------|
| **npm** | `foxschema@0.2.16` |
| **Docker Hub** | `5nickels/foxschema:v0.2.16` / `:latest` |
| **GHCR** | `ghcr.io/tedious-code/foxschema:v0.2.16` |
| **Homebrew** | `Formula/foxschema.rb` → 0.2.16 (after npm) |

## Install / update

```bash
npm install -g foxschema@0.2.16
# or
brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
brew trust tedious-code/foxschema
brew upgrade foxschema
# or
docker pull 5nickels/foxschema:v0.2.16
```

```bash
foxschema stop && foxschema open
foxschema doctor
```

Docker: restart with the **same** `/data` volume.

## Publish checklist (maintainers)

See [publish.md](../publish.md). Short path:

```bash
git fetch origin main && git checkout main && git pull
# package.json should be 0.2.16
git tag v0.2.16
git push origin v0.2.16
gh release create v0.2.16 --title v0.2.16 --notes-file docs/RELEASE_0.2.16.md

# If tag workflows did not start:
gh api -X POST repos/tedious-code/foxschema/dispatches \
  -f event_type=ship-release \
  -f 'client_payload[tag]=v0.2.16'

# After npm shows 0.2.16:
./packaging/homebrew/update-formula.sh 0.2.16
git add Formula/foxschema.rb
git commit -m "brew: foxschema 0.2.16"
git push origin main
```

Verify:

```bash
npm view foxschema version          # 0.2.16
docker pull 5nickels/foxschema:v0.2.16
npm install -g foxschema@latest && foxschema doctor
```
