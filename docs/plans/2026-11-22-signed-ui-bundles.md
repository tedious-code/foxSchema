# Signed UI bundles: publish the frontend to a CDN, serve it from each backend

> **Status (2026-11-22): publishing side written, backend side not started.**
> Done: `API_CONTRACT` and the pinned-key list (`packages/shared/src/ui-bundle.ts`),
> the staging and signing script (`scripts/ui-release/`), the read-only Worker
> that serves the bucket on workers.dev (`scripts/ui-release/cdn-worker/`), and
> `.github/workflows/ui-release.yml` (setup in `docs/guides/publish.md`). Not
> done: the rest of build-order step 1 (`/api/health`, route-table snapshot),
> the compatibility run in step 3, `ship-release.yml` publishing packaged UIs,
> and steps 4–8.
>
> Decided: the browser never loads
> the UI from the CDN. Each user's backend downloads a signed UI bundle, verifies
> it, and serves it from its own origin exactly as it serves the packaged UI
> today. Rejected alternative: a hosted UI on `app.foxschema.com` calling each
> user's backend cross-origin (cookie auth breaks, Chrome's local-network prompt,
> version skew, and one CDN compromise reaches every install's databases).

## Goal

The frontend can ship on its own release train. A UI fix that needs no API change
reaches every install without a new npm package or Docker image, and nothing
about sign-in, cookies, CSP or the origin policy changes, because the page is
still same-origin with the API.

**Not a goal: speed.** The packaged UI is already served from the user's own
machine or server, content-hashed and cached for a year, Brotli-precompressed.
A downloaded bundle is served the same way, so page load is unchanged.

## The one rule that makes this work: the API contract number

A UI bundle is only useful if it can run on a backend that was released before
it. So the UI and the backend share an integer, `API_CONTRACT`, in
`@foxschema/shared`.

- The backend reports `apiContract` and `minUiContract` on `GET /api/health`.
- Within one contract number, API changes are **additive only**: new optional
  fields, new endpoints. Removing or changing anything bumps the number.
- A UI bundle declares the contract it was built against. A backend installs it
  only when `minUiContract <= bundle.apiContract <= apiContract`.
- A UI change that needs a new endpoint is a backend release, as today. The
  bundle for it declares the new contract, and older backends never install it.

Routes declare no request or response schemas today (validation happens inside
the handlers), so no test can see a changed response shape. Two guards instead:

- **Route-table snapshot:** a unit test snapshots every method + path from
  `composeFeatures(FEATURES, …)`. Removing or renaming a route without a
  contract bump fails it. It does not catch a changed field.
- **Compatibility run (the real guard):** `ui-release.yml` runs the e2e smoke
  suite with the new bundle against the *oldest* backend release in its contract
  range (that release's Docker image). A bundle that fails is not published.

A changed field inside a route still depends on review: the PR template gets a
"changes an API response? bump `API_CONTRACT`" checkbox.

## Release format (what CI publishes)

One pack per release and two signed files. No archive format: a pack is every
file's bytes end to end, and the manifest says where each one starts (the sum
of the sizes before it), so there is nothing to unpack and no path or symlink
handling inside a parser.

```
https://fox-ui.foxschema.workers.dev/
  packs/<sha256>                      immutable: every file of one release, end to end
  releases/<version>/manifest.json    immutable, signed: each file's path, hash, size
  channels/stable.json                signed: the newest release per contract, 60 s cache
```

Why one pack and the signature inside each file: the bucket is served by a
Worker on the free plan, which allows 100,000 requests a day with cache hits
counted. A channel check is one request and an update is two; one object per
file would make an update about 300.

A signed file is an envelope: `{ schema, alg: "Ed25519", keyId, signature,
payload }`, where `payload` is the base64 of the exact bytes signed. A backend
verifies the signature over those bytes, then parses only what it verified.

The manifest's payload:

```json
{
  "schema": 1,
  "version": "0.3.26",
  "sequence": 412,
  "apiContract": 7,
  "publishedAt": "2026-11-30T10:00:00Z",
  "pack": { "sha256": "…", "size": 15801755 },
  "files": [
    { "path": "assets/index-3f2a1c.js", "sha256": "…", "size": 201733 },
    { "path": "index.html", "sha256": "…", "size": 1874 }
  ]
}
```

The channel's payload has `sequence`, `expiresAt` (45 days out, re-signed
weekly) and, per contract number, the newest version, its manifest's key and
the sha256 of the manifest's payload.

**Ordering is by `sequence`, never by version string.** `isNewer` in
`updates.service.ts` splits on dots and `parseInt`s each part, so a string like
`0.3.26+ui.1` compares by accident. Every UI build gets a sequence from one
counter, the UI packaged into a backend release included: `ship-release.yml`
publishes that UI to the CDN too and bakes its manifest into the package
(`ui-dist/manifest.json`). Then "is the downloaded bundle newer than the
packaged one?" is one integer comparison, and after a backend upgrade the newer
packaged UI wins over an older download automatically.

**Rolling back a bad release** cannot mean pointing the channel at the old
manifest: backends refuse a lower sequence, by design. A rollback re-publishes
the old release's manifest under the next sequence (the pack is addressed by
hash and never deleted, so nothing is re-uploaded). `ui-release.yml` takes a
`rollback_to: <version>` input that does exactly this.

- **Signature:** Ed25519 over the exact payload bytes. Node's `crypto.verify`
  handles it; `platform/identity/sso-broker.ts` already verifies Ed25519.
- **Public keys are pinned in the backend source**, never fetched from the CDN.
  Ship two (current and next) so a key can be rotated by one backend release.
- **Signing key:** a CI secret in a GitHub environment with required reviewers,
  or better, a cloud KMS key the workflow can sign with but never read.

## Backend: download, verify, activate

New server feature `ui-bundles` (`npm run feature:new -- ui-bundles`), with the
pure parts (manifest parsing, signature and path checks) in
`packages/server/src/platform/ui-bundles/` so `startUiServer` can use them.

**Check** (on startup and every 6 h, and from an admin button):

1. Fetch `channels/stable.json` from `FOX_UI_FEED_URL`, with `If-None-Match`
   so an unchanged channel is a 304. Verify the envelope against the pinned keys. Corporate networks reach the internet
   through a proxy, and Node's `fetch` ignores `HTTPS_PROXY` unless
   `NODE_USE_ENV_PROXY=1`: set that in the Docker image and the CLI launcher, and
   document it.
2. Refuse it if `sequence` is lower than the highest seen (a rollback to an old,
   validly signed, vulnerable UI). If it has expired, keep the current UI and
   report a frozen feed.
3. Pick the entry for the highest contract this backend accepts. Skip it if it
   is the bundle already active, or older than the packaged UI.

**Download:**

4. Fetch the manifest. Verify its envelope, then check its payload's sha256
   against the channel entry.
5. Validate every `path`: relative, `[A-Za-z0-9._/-]` only, no `..` segment, no
   leading `/`, under 2,000 files and 50 MB in total, sizes adding up to the
   pack's size (`parseManifest` in `scripts/ui-release/bundle.mjs` already does
   all of this; move it to `packages/shared` so both sides use one copy).
6. Download `packs/<sha256>`, checking its size and hash, then cut each file out
   by offset into `<store>/staging-<version>/`, checking each file's hash.
7. Rename the staging folder to `<store>/<version>/` (atomic on one filesystem)
   and record it as the pending bundle.

**Activate:** at the next server start in v1, so the static root never changes
under a running request. `startUiServer` picks the root: the newest verified
bundle in the store whose contract fits, else the packaged UI. On start it
re-checks the active bundle's signature and file hashes (a few MB, well under a
second). If anything fails, it serves the packaged UI and logs why.

v2 hot swap: point `@fastify/static` at a `current` symlink, swapped atomically
by rename. The existing 404-on-a-missing-asset reload already covers tabs left
open across the swap.

**Store location:** `/data/ui` in Docker (next to the metadata DB, already a
writable volume), `~/.foxschema/ui` for the CLI. Keep the active and previous
bundles; delete older ones.

**Settings:**

| Variable | Default | Meaning |
|---|---|---|
| `FOX_UI_UPDATES` | `notify` | `auto` downloads and activates on the next restart, `notify` downloads and waits for an admin to apply it, `off` never contacts the feed (air-gapped installs). |
| `FOX_UI_FEED_URL` | `https://fox-ui.foxschema.workers.dev` | Where bundles come from. A mirror for companies that block the internet. |

**Moving the feed later.** The default address is built into every backend, and
old installs keep using it. To move (say, to a custom domain), the channel
payload gets an optional signed `feedUrl`: a backend that verifies it switches
to the new address and stores it. Until then, keep the old address serving.

## Escape hatches

- `?ui=packaged` on any page load serves the packaged UI for that browser
  session, for when a new bundle cannot boot. Both builds use `base: '/'`, so
  both ask for `/assets/…`. The hashes differ, so the static layer can serve
  `/assets/*` from the active bundle *or* the packaged UI (first hit wins), and
  only the choice of `index.html` follows a `fox_ui=packaged` cookie. One
  extra lookup on a miss, no second URL space.
- `foxschema ui status | reset | apply` on the CLI. `reset` deletes the store
  and falls back to the packaged UI.
- Home → Services shows a **Web UI** row with the active bundle's version,
  source (packaged / downloaded) and any pending bundle, plus **Apply** for admins.
  `admin.services` does not exist yet (it is only planned in
  `2026-11-01-service-status.md`), so this step adds it to
  `packages/shared/src/permissions.ts`.
- **Shared servers:** with `LOCAL_SINGLE_USER=false`, Fox already refuses
  machine-level actions such as self-update. Applying a UI bundle writes only to
  the data folder, so it is allowed there, but `auto` is refused: an admin applies
  each bundle.

## CI: `ui-release.yml`

Triggered by a `ui-v*` tag, a manual run (`version` or `rollback_to`) or the
weekly re-sign schedule:

1. `npm ci`, then typecheck and unit tests through `npm run verify`.
2. `npm run build -w @foxschema/web` (it writes the `.br` and `.gz` copies)
   and the first-load budget.
3. After approval in the `ui-release` environment, with no `npm ci` beside the
   key: `scripts/ui-release/ui-release.mjs stage` builds the pack and manifest,
   with `apiContract` from `packages/shared/src/ui-bundle.ts`, and signs both.
4. Upload the pack, then the manifest, then the channel **last**, so no backend
   ever sees a channel naming something not there yet.

Hosting (decided 2026-11-22, cheapest option): the R2 bucket `fox-ui`, read
through the Worker in `scripts/ui-release/cdn-worker/` on `workers.dev`.
foxschema.com's DNS stays at Hostinger; an R2 custom domain would need it on
Cloudflare. The Worker serves only the three key shapes above and refuses
writes; Workers Caching answers repeats from cache using each object's upload
Cache-Control (a year for packs and manifests, 60 s for the channel). Free
plan: 100,000 requests a day, about 20,000 installs checking four times a day;
Workers Paid is $5 a month past that. Do not serve the bucket from `r2.dev`
(rate-limited, no cache) or from the WordPress host (LiteSpeed would cache the
channel).

## Build order

1. `API_CONTRACT` in `@foxschema/shared`, reported on `/api/health`, plus the
   route-table snapshot test and the PR-template checkbox. Useful on its own:
   the UI can already warn about a mismatched backend.
2. Manifest + signature verification module, with tests for: bad signature,
   unknown key, path traversal, oversize, hash mismatch, sequence rollback,
   expired channel, contract out of range.
3. `ui-release.yml` publishing to a staging bucket, the compatibility run
   against the oldest backend in range, the `rollback_to` input, and a local
   fake CDN for tests. `ship-release.yml` publishes each packaged UI too.
4. Downloader and store, with `FOX_UI_UPDATES` / `FOX_UI_FEED_URL`.
5. `startUiServer` root selection and the startup re-verify, used by both
   `apps/web/src/serve.ts` and `apps/cli/src/server/ui-server.ts`.
6. Escape hatches: `?ui=packaged`, `foxschema ui …`, the Services row.
7. Docs: DEPLOYMENT.md settings table, install.md, IMPLEMENTATION_STATE.md, CODE_MAP.md.
8. Live check: Docker and `foxschema open` each pick up a staged bundle, survive
   a tampered file (falls back to packaged), and refuse a rolled-back channel.

## Open questions

- Default for `FOX_UI_UPDATES`: `notify` everywhere (as above), or `auto` for a
  personal install (`LOCAL_SINGLE_USER=true`, the CLI) where the user is the
  admin? Shared servers stay admin-applied either way.
- How far back must a UI release reach? Each contract number kept alive means
  one more backend image in the compatibility run. Suggested: the current and
  previous contract only.
- Telemetry: the feed request reveals each install's IP to the CDN, like the npm
  update check does today. Say so in DEPLOYMENT.md; no other data is sent.
- Who holds the signing key, and does a UI release need a second person's
  approval in the GitHub environment?
