# Deploying Fox Schema

**Day-to-day on a laptop:** install the CLI, open the UI in your browser, optionally add a
desktop shortcut (`foxschema shortcut`). See **[INSTALL.md](INSTALL.md)**.

```bash
npm install -g foxschema
# or:
# brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
# brew trust tedious-code/foxschema && brew install foxschema
foxschema                  # http://localhost:3210
foxschema shortcut
```

Maintainers: **[PUBLISH.md](PUBLISH.md)**.

### Sign-in + RBAC

Every install requires sign-in with an email and password — Docker, `fox open`
and the desktop app alike. Roles are `admin` / `editor` / `owner` / `viewer`.

- **First run** shows a setup screen that creates the administrator account. On
  an install that was used before sign-in was required, setup *claims* the
  existing local account (email pre-filled from `fox setup` when bound), so
  saved connections and history carry over.
- **Setup from another machine** (a server, a container) asks for a one-time
  **setup code**, printed in the Fox server log when someone opens the setup
  screen remotely. From the machine itself no code is needed. Behind a reverse
  proxy every visitor counts as remote.
- **No self-registration.** Admins invite people under **Profile → Access
  control → App users**: an invite sends a one-time code, and the person chooses
  their own password. (A starting password to hand over still works.)
- **Forgot password** on the sign-in page sends a one-time reset code (30
  minutes, works once, ends every other session). Admins can also send one from
  the user's row. See [Email for invites and resets](#email-for-invites-and-resets).
- **Google, Microsoft and GitHub** sign in an existing account whose email the
  provider has verified. Set them up under **Access control → Sign-in**, or with
  the `SSO_*` variables.
- **Sign-in is rate-limited** per address (20 per 15 minutes) and **locked per
  email** after 5 failures for 15 minutes, for emails with and without an
  account alike. New passwords need 10+ characters and must not be a common
  password or contain the email name.
- First UI open can still show the **email subscriber wizard** (public; before sign-in).
- Admins configure role permissions and assign users under **Profile → Access control**.
- Permissions cover Schema Sync (browse / compare / migrate), SQL Editor (sidebar, variables, writes, Data grid insert/update/delete, code cells), Utilities, Secrets, Access, and Workflow (`workflow.access` / `design` / `run` / `admin`).
- **Database Access** catalog (`POST /schema/db-access`) is an OR gate: **Use utilities** *or* any Access-workspace permission (`access.access`, Users, builder, diff, inspector, report) may load it. GRANT / REVOKE still needs **Grant privileges**.

**Servers / teams:** Fox Schema ships as a **single Docker image** (all dialects including
Db2) that serves both the UI and the API on one configurable port (default **3210**).

- [Install (all channels)](INSTALL.md)
- [CLI / Homebrew](homebrew.md)
- [Quick start (Docker)](#quick-start)
- [Configuration (environment variables)](#configuration-environment-variables)
- [The encryption key](#the-encryption-key)
- [Choosing a port](#choosing-a-port)
- [Where app data lives](#where-app-data-lives)
- [Access: sign-in + SSO](#access-sign-in--sso)
- [Email for invites and resets](#email-for-invites-and-resets)
- [Cloud platforms](#cloud-platforms)
- [Database drivers](#database-drivers)
- [Building the image](#building-the-image)

## Quick start (pull and run)

No `.env` required. The image auto-generates `APP_ENCRYPTION_KEY` on first boot
and stores it on the `/data` volume.

```bash
docker pull 5nickels/foxschema:latest
docker run -d --name foxschema \
  -p 3210:3210 \
  -v foxschema_data:/data \
  5nickels/foxschema:latest
```

Open http://localhost:3210

Defaults baked into the image: sign-in required (first open creates the admin —
read the setup code from `docker logs`), SQLite metadata on
`/data`, port `3210`, **Db2 client included**. Image is **linux/amd64** only
(`ibm_db` has no linux/arm64 build). Keep the same volume across upgrades so saved
connections and the encryption key survive.

There is no separate `db2-latest` tag — `latest` is the one image.

### Optional: pin your own encryption key

```bash
docker run -d --name foxschema \
  -p 3210:3210 \
  -e APP_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -v foxschema_data:/data \
  5nickels/foxschema:latest
```

### docker compose

```bash
docker compose -f docker-compose.app.yml up -d
# or build locally: docker compose -f docker-compose.app.yml up -d --build
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3210` | Host port published by docker-compose (what you open in a browser). |
| `API_PORT` | `3210` | Port the app listens on **inside** the container. `PORT` maps to it. |
| `APP_ENCRYPTION_KEY` | auto on `/data` | Encrypts saved DB passwords. Optional in Docker: entrypoint creates `/data/.app_encryption_key` if unset. Set explicitly for managed/secret-store deploys. |
| `APP_DB_ENGINE` | `sqlite` | The app's own metadata store: `sqlite`, `postgres`, or `mysql`. |
| `APP_DB_PATH` | `/data/foxschema.db` | SQLite file location (when `APP_DB_ENGINE=sqlite`). |
| `APP_DB_URL` | — | Connection URL for the metadata store when engine is `postgres`/`mysql`. |
| `APP_KEY_SCHEME` | `v1` | `v1` = key used directly. `v2` = key bound to `APP_USER_EMAIL` (anti-copy); leave `v1` for stateless servers. |
| `LOCAL_SINGLE_USER` | `true` | Whether this is a personal install (`true`) or a shared server (`false`). Sign-in is required either way; this only decides machine-level actions (installing drivers, self-update, changing the metadata DB, host cloud credentials), which a shared server refuses. |
| `SIGNUP_WEBHOOK_URL` | — | Optional. The first-open subscriber wizard posts here (WordPress `/foxschema/v1/signup`, which emails contact@foxschema.com), and so does a new account whose owner ticks **Email me Fox news** at sign-up or when accepting an invite (unticked by default; never on a password reset). Without it, subscribing is a local no-op and never blocks sign-up. |
| `SIGNUP_WEBHOOK_SECRET` | — | Optional shared secret sent as `X-Foxschema-Signup-Secret`. |
| `UPDATE_FEED_URL` | npm `foxschema/latest` | Version check for in-app update toasts. Default is the npm registry. The “What’s new” link opens the matching GitHub Release page. Set `off` to disable. |
| `APP_VERSION` | from `package.json` | Running version compared against the feed. The CLI sets this from the installed npm package. |
| `FOXSCHEMA_SELF_UPDATE` | `true` via CLI open | When `true`, UI can run `npm install -g foxschema@latest`. Off in Docker / set `false` to require a manual terminal upgrade. |
| `ALLOW_HOST_CLOUD_CREDENTIALS` | off | When `true`, cloud secret resolve may use the host IAM/ADC chain without saved user credentials. **Keep off** on multi-user hosts. |
| `LISTEN_HOST` | `0.0.0.0` with `NODE_ENV=production`, else `127.0.0.1` | Address the server listens on. Outside production, a network address is refused at startup unless `FOX_INSECURE_DEV=1`. |
| `FOX_INSECURE_DEV` | off | `1` lets a development server (no `NODE_ENV=production`) listen on a network address. Such a server encrypts saved credentials with a development key when `APP_ENCRYPTION_KEY` is unset and sends its session cookie without the Secure flag, so use it only on a network you trust. |
| `SSO_*` | — | OAuth for Google / Microsoft / GitHub (see below). Can also be set under Access control → Sign-in. |
| `APP_PUBLIC_URL` | — | The URL people reach Fox at (`https://fox.example.com`). Invite and reset emails link here; SSO callbacks use it. `SSO_REDIRECT_BASE` is read as a fallback. Can also be set on the Sign-in screen. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | — | Relay for invite and password-reset emails. `SMTP_SECURITY` is `tls` (465), `starttls` (587, default) or `none`. Needs at least `SMTP_HOST` and `SMTP_FROM`. See [Email for invites and resets](#email-for-invites-and-resets). |
| `FOX_SSO_BROKER` | off | `on` lets people sign in with Google / GitHub **through the Fox sign-in service** on foxschema.com, with no OAuth app of your own (also a switch under Access control → Sign-in). See [Fox sign-in service](#fox-sign-in-service). |
| `FOX_SSO_BROKER_URL` | `https://foxschema.com/wp-json/foxschema/v1/sso` | Where the sign-in service lives. |
| `FOX_GIT_DIR` | beside the metadata DB (`<dir>/git`), else `~/.foxschema/git` | Where Fox keeps local copies of the Git repositories migrations are committed to (bare clones; safe to delete — they are fetched again). |
| `FOX_GIT_ALLOW_HTTP` | off | Development only: accept `http://` Git remotes. Ignored when `NODE_ENV=production`; production remotes are always `https://`. |
| `FOX_TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which peers' `X-Forwarded-*` headers are believed. Only a proxy may say who the client is; trusting everyone let any client pick its own address and skip rate limits. Set to your proxy's address or CIDR if it is on a public IP, or `true` / `false`. |
| `FOX_SETUP_ALLOW_LOCAL_WITHOUT_CODE` | off | Skip the first-run setup code for a direct loopback request. The `foxschema open` launcher sets this because it binds only to loopback. Never enable it behind a reverse proxy: an unlabelled proxy request is indistinguishable from a local one. |
| `NODE_ENV` | `production` | Set in the image; enforces that `APP_ENCRYPTION_KEY` is present. |
| `FOX_ALLOWED_ORIGINS` | — | Comma-separated browser origins allowed to call the API with cookies. When set, it is the entire allowlist. See [Origin policy](#origin-policy). |

> The app also reads `APP_USER_EMAIL` (only for the `v2` key scheme).
> Update checks default to the npm `foxschema` registry feed (see below).

### Workflow engine

The workflow engine (`apps/workflow-server`) is a separate process: a slow or
failing run never shares a process with FoxSchema. FoxSchema reaches it through
its engine proxy, and the engine calls FoxSchema back to resolve saved
connections a user linked to workflows and to read the engine settings saved in
the admin screen. Both directions authenticate with one shared token.

| Variable | Set on | Default | Purpose |
|----------|--------|---------|---------|
| `WORKFLOW_ENGINE_TOKEN` | both | — | Shared service token. Set the **same** long random value on FoxSchema and the engine. Without it the engine API is open (loopback dev only) and saved connections cannot be used by workflows. |
| `FOXSCHEMA_URL` | engine | `http://127.0.0.1:3210` | Where the engine reaches FoxSchema's API. |
| `PORT` / `HOST` | engine | `8081` / `127.0.0.1` | The engine API. Keep it on a private interface. |
| `INGRESS_PORT` / `INGRESS_HOST` | engine | unset / `127.0.0.1` | Webhook and API-endpoint ingress on a listener of its own, serving only `/api/hooks/*` and `/api/triggers/*`. Put this one behind your public reverse proxy; webhook traffic then never touches FoxSchema or the engine API. |
| `WORKFLOW_LOG_DIR` | engine | `workflow-logs/` next to the engine database | Directory for the JSON / text run-event sinks enabled in the admin screen. A sink target is a file name inside it, never a path. |
| `FOXFLOW_ENCRYPTION_KEY` | engine | — | **Required at boot.** 32-byte key (hex or base64) encrypting the engine's own credential store. No plaintext fallback. |
| `FOXFLOW_DB_PATH` | engine | `workflow-engine.sqlite` at the repo root | The engine's SQLite database. |
| `FOXFLOW_FILES_DIR` | engine | `workflow-files/` next to the engine database | The only directory the file pipes (CSV / JSON / text sources, Write CSV file, the designer's file preview) read or write. A relative pipe path is taken from here; an absolute one must already be inside it. |
| `FOXFLOW_TRUST_PROXY` | engine | `false` | Trust `X-Forwarded-*` when the engine sits behind a proxy. |

The engine re-reads its settings from FoxSchema every 30 seconds: `Disabled`
refuses new runs from every trigger, `Draining` finishes work in flight, and
`Max parallel runs` caps runs executing at once in each engine process. If FoxSchema is unreachable the
engine keeps the settings it last had.

`FOXFLOW_ENCRYPTION_KEY` is **required at engine boot** (32 bytes, hex or base64) —
there is no plaintext fallback. Default `FOXFLOW_DB_PATH` in a git checkout is
repo-root `workflow-engine.sqlite`, not relative to cwd, so server / scheduler /
worker share one file. Optional split roles:

```bash
npm -w @foxschema/workflow-server run start:scheduler   # admit cron/poll, queue runs
npm -w @foxschema/workflow-server run start:worker      # claim queued runs
```

**The published Docker image does not start the engine.** `Dockerfile` /
`docker-compose.app.yml` run FoxSchema only. Deploy `apps/workflow-server` beside
it (same token on both). Local checkout: `npm run dev:with-workflow`. Full
runbook: [WORKFLOW.md](WORKFLOW.md).

### First-open email subscriber wizard

On **first UI boot of a brand-new install** (before login), Fox can show a skippable
welcome form that collects an email for product updates. Routes are public:
`GET /api/signup/state`, `POST /api/signup`, `POST /api/signup/skip`. Configure
`SIGNUP_WEBHOOK_URL` (+ optional secret) so submissions reach foxschema.com;
otherwise subscribe still dismisses locally.

**Existing installs:** upgrading keeps your `/data` (or `APP_DB_*`) metadata DB.
The upgrade migration marks the wizard as already shown, so people who already
use Fox are not interrupted. Only greenfield metadata DBs see the prompt.

**Sign-in upgrade:** installs that ran without sign-in open on the setup screen,
which claims the existing local account — nothing is lost. Deployments that
already ran with `LOCAL_SINGLE_USER=false` keep their accounts and passwords and
never show setup; their local account cannot be claimed.

**Query files / SQL Editor:** browser localStorage (`foxschema-sql-editor`) and
saved credentials keep working. New **Utilities → Query files** workspaces appear
as `Files: …` SQLite connections; expired temp DBs (~24h) are removed and their
orphan credentials are pruned on the next connections/Files list load — regular
saved credentials are never touched. Keep `APP_ENCRYPTION_KEY` (or the Docker
`/data` volume that stores it) stable across upgrades.

## The encryption key

`APP_ENCRYPTION_KEY` protects the database passwords Fox stores.

- **Docker pull-and-run:** leave it unset; the entrypoint writes a random key to
  `/data/.app_encryption_key` and reuses it on later starts (as long as you keep
  the `/data` volume).
- **Pin your own key** (recommended for production secret managers):

```bash
openssl rand -hex 32
```

- **Keep it stable and secret.** If it changes, previously saved passwords can't be
  decrypted and must be re-entered.
- Running `serve.ts` outside Docker still requires the env var in production.

## Choosing a port

Default is **3210** (CLI, Docker, and `npm run dev` API — avoids crowded 3000/3001).
If it conflicts, set `PORT` (and optionally `API_PORT`):

```bash
# .env
PORT=8090          # published on the host — open http://localhost:8090
API_PORT=3210      # inside the container; PORT maps to it (fine to leave as-is)
```

With `docker run`, just change the left side of `-p 8090:3210`.

Local CLI: `foxschema open` will try **3211–3229** automatically when 3210 is busy
unless you pass `--port` (or set `FOXSCHEMA_PORT`).

## Where app data lives

Fox Schema's **own** database (saved connections, migration history, settings — *not* the
databases you compare) defaults to a SQLite file on the **`/data` volume**.

- **Keep the volume** to keep your data across restarts/upgrades. `docker compose down`
  keeps it; `docker compose down -v` **deletes** it.
- **Stateless / ephemeral-disk platforms** (e.g. Cloud Run) reset local disk on each
  start. There, point the metadata store at a managed database instead of the volume:

  ```bash
  APP_DB_ENGINE=postgres
  APP_DB_URL=postgresql://user:pass@db-host:5432/foxmeta
  # (mysql works too: APP_DB_ENGINE=mysql, APP_DB_URL=mysql://…)
  ```

  Then you don't need the `/data` volume at all.

## Access: sign-in + SSO

**Every install requires sign-in.** Until the first admin exists the server is
in setup, and anyone who completes setup owns it — which is why setup from
another machine needs the one-time code from the server log. Complete setup
before exposing a new deployment, and still keep internet-facing installs behind
TLS and, ideally, a VPN or your platform's access controls.

For a shared deployment, declare it and add SSO if you use one:

```bash
LOCAL_SINGLE_USER=false
SSO_REDIRECT_BASE=https://fox.example.com     # your public URL

# Enable one or more providers (both ID and SECRET required per provider):
SSO_GOOGLE_CLIENT_ID=...
SSO_GOOGLE_CLIENT_SECRET=...
SSO_GITHUB_CLIENT_ID=...
SSO_GITHUB_CLIENT_SECRET=...
SSO_MICROSOFT_CLIENT_ID=...
SSO_MICROSOFT_CLIENT_SECRET=...
SSO_MICROSOFT_TENANT=common
```

Set each provider's OAuth redirect/callback to `${SSO_REDIRECT_BASE}/api/auth/sso/<provider>/callback`
(the Sign-in screen shows it, ready to copy).
SSO proves who someone is; an admin still has to add their account first.

Which email SSO trusts, per provider — the part that decides whose account opens:

| Provider | Accepted email |
|---|---|
| Google | only with `email_verified: true` |
| GitHub | the account's **primary, verified** address from `/user/emails` |
| Microsoft | a personal Microsoft account; a work account whose domain Microsoft marks verified (`xms_edov`); or any account of the tenant in `SSO_MICROSOFT_TENANT` when it is a single tenant ID. With `common` / `organizations`, an unverified work-account email is refused — any tenant's admin can type any address into it. |

The flow uses PKCE (S256) and a state cookie compared in constant time.

### Fox sign-in service

Registering a Google client and a GitHub app is a chore for a single install.
Instead, an admin can turn on **Use the Fox sign-in service** (Access control →
Sign-in, or `FOX_SSO_BROKER=on`): the Google and GitHub buttons then go through
foxschema.com, which holds one app for each.

1. Fox sends the browser to `…/sso/start` with a random nonce, also kept in an
   HttpOnly cookie in that browser, and its own callback URL.
2. foxschema.com signs the person in with the provider (PKCE), keeps only a
   provider-verified email (Google `email_verified`; GitHub's verified primary
   address), and sends the browser back with an **Ed25519-signed assertion**
   valid for two minutes.
3. Fox checks the signature against `…/sso/jwks`, that the assertion is for
   **its own callback URL** and **this browser's nonce**, that it is fresh and
   unused, and then signs in an **existing** account with that email.

Turning it on trusts foxschema.com to say who is signing in, and it sees the
emails used (it does not store them). It is off by default for that reason.
An install's own Google or GitHub app, when configured, is used instead.

### Email for invites and resets

With a relay configured, invites and reset codes are emailed. Without one, the
code is written to the server log (the same channel as the setup code) and
shown to the admin who issued it, and `foxschema reset-password [email]` prints a
fresh reset code on the machine Fox runs on.

Configure it on **Access control → Sign-in → Email** (presets for Hostinger,
Gmail and Microsoft 365, and a *Send test email* button), or:

```bash
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURITY=tls
SMTP_USERNAME=contact@example.com
SMTP_PASSWORD=...                  # the mailbox password
SMTP_FROM="Fox <contact@example.com>"
APP_PUBLIC_URL=https://fox.example.com
```

Links in the emails use the public URL only — never the request's `Host`
header, which the requester controls. Without a public URL the email carries
the code alone. Codes are 60 random bits, stored only as SHA-256 (as are
session tokens), and the link puts the code in the URL fragment so it never
reaches a server log.

**App Secrets / cloud credentials on multi-user hosts:** with `LOCAL_SINGLE_USER=false`,
resolving AWS/GCP/Azure secrets requires a saved credential under **Credentials → Cloud
providers** for that user. Host instance profiles / ADC are **not** used unless you
explicitly set `ALLOW_HOST_CLOUD_CREDENTIALS=true` (not recommended on shared servers).
Azure `vaultUrl` values must be HTTPS `*.vault.azure.net` (or known sovereign-cloud vault
hostnames).

**Always terminate TLS** (via your reverse proxy or platform) for any internet-facing
deployment — Fox Schema handles database credentials.

## Origin policy

The API holds database credentials and can run migrations, so only named browser
origins may call it with cookies (`packages/server/src/platform/guards/origin-policy.ts`).
The allowlist is explicit, not “any localhost”.

| Mode | Who may call |
|------|----------------|
| `FOX_ALLOWED_ORIGINS` set | **Only** those comma-separated origins (scheme + host + port). Wins over everything else. |
| Production, unset | The origin this process is served from, plus same-origin `fetch` (`Origin` matching this request's host). Docker / `foxschema open` work without extra config. |
| `npm run dev` | This machine's **literal** addresses (`localhost`, `127.0.0.1`, `[::1]`, and `os.networkInterfaces()` IPs) on ports **5173**, **5199**, **3210**, **3211**. Hostnames other than `localhost` are refused — DNS rebinding can point `evil.com` at 127.0.0.1, and Vite (`allowedHosts: true`) would serve it. |

A missing `Origin` is allowed (curl, health checks). A refused Origin is **403**
with `This origin is not allowed to call the Fox Schema API.` — that is why a
LAN Vite URL used to look like a blank / disconnected UI.

```bash
# Split UI hostname in production
FOX_ALLOWED_ORIGINS=https://fox.example.com,https://fox.example.com:443
```

## Cloud platforms

The image is a standard single-port web server, so it runs anywhere containers do:

- **VPS / your own Docker host:** `docker compose -f docker-compose.app.yml up -d` with
  a persistent volume; front it with nginx/Caddy/Traefik for TLS.
- **Render / Railway / Fly.io / Cloud Run / ECS:** deploy the image, set the env vars
  as secrets, and let the platform's injected `PORT` be honored (the server reads
  `API_PORT` then `PORT`). On ephemeral-disk platforms, use an external metadata DB
  (above) instead of the volume.

The image is **linux/amd64** (includes Db2). On arm64 hosts, use emulation or the
npm/Homebrew CLI.

## Database drivers

The published image includes **all dialects, including Db2** (`ibm_db`). It is
**linux/amd64 only** because `ibm_db` has no linux/arm64 build.

On Apple Silicon, pull with Docker Desktop (emulation) or use the npm/Homebrew CLI
instead. There is no separate “common” vs “db2” image.

## Pulling the published image

Every tagged release (`v*`) publishes one image via `.github/workflows/web-release.yml`.

**Docker Hub** ([5nickels/foxschema](https://hub.docker.com/repository/docker/5nickels/foxschema/tags)):

```bash
docker pull 5nickels/foxschema:latest
```

**GitHub Container Registry:**

```bash
docker pull ghcr.io/tedious-code/foxschema:latest
```

CI pushes both registries when these Actions secrets are set:

| Secret | Value |
|--------|--------|
| `DOCKERHUB_USERNAME` | `5nickels` |
| `DOCKERHUB_TOKEN` | Hub **Access Token** with Read & Write (not your password) |

## Building the image

```bash
docker build --platform=linux/amd64 -t foxschema .
# or:  docker compose -f docker-compose.app.yml up -d --build
```

The image:
- Uses `npm install` (no committed lockfile), builds the Vite frontend to
  `apps/web/dist`, then runs the API + static server via
  `apps/web/src/serve.ts`.
- Runs as a non-root user and exposes a `/api/health` healthcheck.
- Includes Db2 by default (`WITH_DB2=true`). For a local lean build without Db2:
  `docker build --build-arg WITH_DB2=false -t foxschema:lite .`
