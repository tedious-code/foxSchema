# Fox Schema 0.2.36

Ship cut for **npm · Docker · Homebrew**. Covers everything since **`v0.2.33`**;
`0.2.34`/`0.2.35` were auto-bumps on `main`.

## Highlights

- **RBAC — last admin protected** — demoting or deactivating the final active
  admin is now blocked, so an instance can no longer be locked out of its own
  Access screen (#175).
- **Core split** — `packages/core` became `@foxschema/sql` (pure dialect
  knowledge: SQL generation, schema compare, statement splitting, type mapping,
  zero dependencies) and `@foxschema/db` (Node runtime: drivers, pooling,
  migration execution), with a service layer between them (#176).
- **Publish tooling for `@foxschema/sql`** — build + staging script so the
  package can ship to npm with `exports` pointing at `dist` while the workspace
  keeps resolving TypeScript source (#177).

No user-facing behaviour changes from the split: the app, CLI, and Docker image
resolve the same code through the new package boundaries.

## Seamless upgrade (from 0.2.33)

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
| **npm** | `foxschema@0.2.36` |
| **Docker Hub** | `5nickels/foxschema:v0.2.36` / `:latest` |
| **GHCR** | `ghcr.io/tedious-code/foxschema:v0.2.36` |
| **Homebrew** | `Formula/foxschema.rb` → 0.2.36 (after npm) |

`@foxschema/sql` and `@foxschema/db` are **not** part of this release. They ship
on their own version line once the `@foxschema` npm scope exists.

## Install / update

```bash
npm install -g foxschema@0.2.36
# or
brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
brew trust tedious-code/foxschema
brew upgrade foxschema
# or
docker pull 5nickels/foxschema:v0.2.36
```

```bash
foxschema stop && foxschema open
foxschema doctor
```

## Verification for this cut

- `vitest run` — 880 passed, 2 skipped (99 files)
- `tsc --noEmit` on `apps/web` — clean
- `@foxschema/web` + `@foxschema/cli` builds and npm pack staging — clean

## Publish checklist (maintainers)

See [publish.md](../publish.md). Short path:

```bash
git fetch origin main && git checkout main && git pull
# package.json should be 0.2.36
git tag v0.2.36
git push origin v0.2.36
gh release create v0.2.36 --title v0.2.36 --notes-file docs/RELEASE_0.2.36.md

# After npm shows 0.2.36:
./packaging/homebrew/update-formula.sh 0.2.36
git add Formula/foxschema.rb
git commit -m "brew: foxschema 0.2.36"
git push origin main
```

Verify:

```bash
npm view foxschema version          # 0.2.36
docker pull 5nickels/foxschema:v0.2.36
npm install -g foxschema@latest && foxschema doctor
```
