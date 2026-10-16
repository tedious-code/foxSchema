# Fox Schema 0.2.33

Hotfix ship for **npm · Docker · Homebrew**. Includes SQL Editor SELECT UX
from **#173**, plus access-control work from **#171** since **`v0.2.31`**.

## Highlights

- **SQL Editor SELECT column picker** — Select all (`*`), Remove all, and
  checkbox toggles that stay in sync with the live SQL (#173).
- **Auto table aliases** — Schema tree click *or* `FROM` autocomplete inserts
  `table alias` (e.g. `orders ord`); opening the column picker aliases bare
  `FROM` tables and rewrites `table.col` → `alias.col` (#173).
- **Picker reliability** — closes on outside click / Escape; fixed false
  “No columns found” when SELECT lists used `table.col` commas (#173).
- **Access control** — Users **Active** checkbox; admin **Change password**;
  press-and-hold password reveal (#171).
- **Docker build** — keep `monaco-editor@0.55.1` pinned so image builds
  succeed after the 0.56 exports-map break.

## Seamless upgrade (from 0.2.31)

1. Keep the Docker `/data` volume (or metadata DB path) and a stable
   `APP_ENCRYPTION_KEY`.
2. Update, then run:

   ```bash
   foxschema stop && foxschema open
   ```

3. No credential re-entry when the encryption key is unchanged.

## Distribution

| Channel | Artifact |
|---------|----------|
| **npm** | `foxschema@0.2.33` |
| **Docker Hub** | `5nickels/foxschema:v0.2.33` / `:latest` |
| **GHCR** | `ghcr.io/tedious-code/foxschema:v0.2.33` |
| **Homebrew** | `Formula/foxschema.rb` → 0.2.33 (after npm) |

## Install / update

```bash
npm install -g foxschema@0.2.33
# or
brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
brew trust tedious-code/foxschema
brew upgrade foxschema
# or
docker pull 5nickels/foxschema:v0.2.33
```

```bash
foxschema stop && foxschema open
foxschema doctor
```

## Publish checklist (maintainers)

See [publish.md](../publish.md). Short path:

```bash
git fetch origin main && git checkout main && git pull
# package.json should be 0.2.33
git tag v0.2.33
git push origin v0.2.33
gh release create v0.2.33 --title v0.2.33 --notes-file docs/RELEASE_0.2.33.md

# If tag workflows did not start:
gh api -X POST repos/tedious-code/foxschema/dispatches \
  -f event_type=ship-release \
  -f 'client_payload[tag]=v0.2.33'

# After npm shows 0.2.33:
./packaging/homebrew/update-formula.sh 0.2.33
git add Formula/foxschema.rb
git commit -m "brew: foxschema 0.2.33"
git push origin main
```

Verify:

```bash
npm view foxschema version          # 0.2.33
docker pull 5nickels/foxschema:v0.2.33
npm install -g foxschema@latest && foxschema doctor
```
