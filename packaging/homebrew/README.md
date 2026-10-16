# Homebrew (same repo)

The formula lives in this monorepo at [`Formula/foxschema.rb`](../../Formula/foxschema.rb).
There is **no** separate `homebrew-foxschema` tap.

## Install (users)

User install for every channel, including Homebrew, is [docs/install.md](../../docs/install.md). This file is only how to refresh the formula after a release.

## Updating after an npm release

1. Publish `foxschema@VERSION` to npm.
2. Refresh the formula checksum:

```bash
./packaging/homebrew/update-formula.sh 0.1.67
```

3. Commit `Formula/foxschema.rb` on `main` and push.

Users who already tapped get updates with `brew update && brew upgrade foxschema`.
