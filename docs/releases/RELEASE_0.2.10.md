# Fox Schema 0.2.10

Ship cut for **npm · Docker · Homebrew**. Covers everything since **`v0.2.4`**
(current public Latest). Intermediate `0.2.5`–`0.2.9` were auto-bumps on `main`.

## Highlights

- **Utilities → Query files** — CSV/TSV (delimiter presets), JSON/NDJSON, and
  fixed-width text → temp `Files:` SQLite workspaces (multi-table, chunked
  upload) or bulk-load into a saved credential; Files sidebar to list / reuse /
  delete / clear
- **Utilities → Server Insights** — pool, sessions, system, and object-size
  probes by dialect
- **Editable Data Peek** — add / edit / clone / delete rows (permission-gated);
  viewers stay read-only
- **RBAC** — `admin` / `editor` / `viewer` + Access control; multi-user mode can
  require login (`LOCAL_SINGLE_USER=false`)
- **CockroachDB migrations** — generate-time DROP/CREATE for dependent views /
  routines around structural ALTER (web UI + CLI/TUI)
- **Seamless upgrade** — keep `/data` + `APP_ENCRYPTION_KEY`; orphan `Files:`
  credentials pruned after temp DB TTL; signup wizard suppressed on used installs
- **Desktop (Tauri) retired** — use `foxschema` CLI + browser, or Docker

## Seamless upgrade (from 0.2.4)

1. Keep the Docker `/data` volume (or metadata DB path) and a stable
   `APP_ENCRYPTION_KEY`.
2. Install/update, then boot once — metadata migrations apply automatically;
   existing users become **admin**.
3. SQL Editor tabs/bookmarks/variables rehydrate from the same
   `foxschema-sql-editor` localStorage key.
4. No credential re-entry when the encryption key is unchanged.

## Distribution

| Channel | Artifact |
|---------|----------|
| **npm** | `foxschema@0.2.10` |
| **Docker Hub** | `5nickels/foxschema:v0.2.10` / `:latest` |
| **GHCR** | `ghcr.io/tedious-code/foxschema:v0.2.10` |
| **Homebrew** | `Formula/foxschema.rb` → 0.2.10 (after npm) |

## Install / update

```bash
npm install -g foxschema@0.2.10
# or
brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
brew trust tedious-code/foxschema
brew upgrade foxschema
# or
docker pull 5nickels/foxschema:v0.2.10
```

```bash
foxschema                 # local UI
foxschema doctor
```

Docker: restart with the **same** `/data` volume.

## Publish checklist (maintainers)

See [publish.md](../publish.md). Short path:

```bash
git fetch origin main && git checkout main && git pull
# package.json should be 0.2.10
git tag v0.2.10
git push origin v0.2.10
# or: gh release create v0.2.10 --title v0.2.10 --notes-file docs/RELEASE_0.2.10.md

# If tag workflows did not start:
gh api -X POST repos/tedious-code/foxschema/dispatches \
  -f event_type=ship-release \
  -f 'client_payload[tag]=v0.2.10'

# After npm shows 0.2.10:
./packaging/homebrew/update-formula.sh 0.2.10
git add Formula/foxschema.rb
git commit -m "brew: foxschema 0.2.10"
git push origin main
```

Verify:

```bash
npm view foxschema version          # 0.2.10
docker pull 5nickels/foxschema:v0.2.10
npm install -g foxschema@latest && foxschema doctor
```
