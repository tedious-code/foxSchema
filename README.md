<div align="center">

# Fox Schema

**Compare schemas · generate migrations · run SQL — across 14 SQL dialects.**

Install once, then open the local web UI (`foxschema`) for **Compare**, the
**SQL Editor**, **Utils**, **Snapshots**, and optional **Workflow**. Self-host with Docker when you need a server.

[foxschema.com](https://foxschema.com) · [Install](docs/install.md) · [User guide](docs/user-guide.md) · [Workflow](docs/workflow.md) · [Docs](docs/README.md) · [Contributing](CONTRIBUTING.md)

<p>
  <a href="https://www.npmjs.com/package/foxschema"><img alt="npm" src="https://img.shields.io/npm/v/foxschema.svg?logo=npm" /></a>
  <a href="https://hub.docker.com/r/5nickels/foxschema"><img alt="Docker" src="https://img.shields.io/docker/v/5nickels/foxschema?label=docker&logo=docker" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white" />
  <img alt="Node ESM" src="https://img.shields.io/badge/Node-ESM%20%2B%20CJS%20deps-339933?logo=nodedotjs&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" />
</p>

</div>

## Install

Requires **Node.js ≥ 22.5** (npm / Homebrew). Docker needs no Node.

```bash
# npm — macOS, Windows, Linux (arm64 + x64)
npm install -g foxschema

# Homebrew — macOS (formula in this repo; Homebrew 6+ needs trust once)
brew tap tedious-code/foxschema https://github.com/tedious-code/foxschema
brew trust tedious-code/foxschema
brew install foxschema

# Docker — servers (linux/amd64, includes Db2)
docker pull 5nickels/foxschema:latest
```

Windows:

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g foxschema
```

Full matrix: **[docs/install.md](docs/install.md)**.

## Update

```bash
npm install -g foxschema@latest          # npm
brew update && brew upgrade foxschema    # Homebrew
docker pull 5nickels/foxschema:latest    # Docker, then recreate the container
```

A running `foxschema` also tells you when a new version is out, links to
**What's new**, and on a local install offers **Update now**.
Release notes: [0.3.1](docs/releases/RELEASE_0.3.1.md) · [all versions](docs/releases/SUMMARY.md).

## Use the app

```bash
foxschema                 # start UI on http://localhost:3210 and open the browser
foxschema shortcut        # put a Fox icon on your Desktop
foxschema stop            # stop the background server
foxschema doctor
```

Headless / CI:

```bash
foxschema compare --source a --target b
foxschema migrate --source a --target b
foxschema tui
```

## What's in 0.3

| Area | What you get |
|------|----------------|
| **Compare & deploy** | Color-coded schema diff, cross-dialect readiness, an execute gate that reviews a missing foreign key or a narrowing type before it runs, streamed deploy progress |
| **Snapshots** | Capture a schema version, browse the timeline and graph, compare two versions, revert, or force-migrate a version to another database |
| **Migrations in Git** | Commit a migration to a repository, pull and push, track what was applied where |
| **SQL Editor** | Multi-destination run, notebook cells, FoxScript, Data Peek, Safe mode, one transaction where the engine can roll back (below) |
| **Data compare & migrate** | Compare 2,000 rows in key order between two databases, then apply up to 2,000 changes with a backup snapshot you can restore |
| **Utilities** | **Rename Column** (in place, or Large table mode with a batched copy, on every SQL engine), Index management, Backup & Restore commands, SQL Tracer, Server insights, Clone table |
| **Access** | Database accounts, a permission builder that writes GRANT / REVOKE, an inspector of who holds what, an access report |
| **Workspaces & sign-in** | Personal and team workspaces, invites, Google / Microsoft / GitHub sign-in, admin roles and a role → permission matrix |
| **Workflow** | Optional designer and engine for scheduled and triggered jobs (below) |

Every feature, where it lives and how it is tested: [docs/FEATURE_MAP.md](docs/FEATURE_MAP.md).

## SQL Editor

A full query workbench next to Schema Sync — not a thin prompt.

![SQL Editor — multi-destination run, Data Peek, FoxScript](docs/demo/sql-editor.gif)

| Feature | What you get |
|---------|----------------|
| **Multi-destination Run** | Same SQL against every checked connection; By-cred or Side-by-side results |
| **Notebook cells** | SQL + `-- @js` / `-- @ts` / `-- @node` cells with per-cell ▶ and `Out [n]` |
| **FoxScript** | Monaco language, fences, markers, schema-aware tokens |
| **Data Peek** | Cmd/Ctrl-click a table in Schema, or click rust FK cells in results; edit rows when allowed |
| **Peek tools** | WHERE / ORDER BY / LIMIT, Prev/Next, drag ⋮⋮ to arrange, resize |
| **Query files** | CSV / JSON / fixed-width → temp `Files:` SQLite or bulk-load into a saved credential |
| **Schema explorer** | Insert names, autocomplete, edit table / view source |
| **Variables & secrets** | `${{name}}`, `@set`, session secrets, code-cell `vars` |
| **Safe mode** | Confirm writes; bookmarks & samples included |
| **Access control** | Sign-in on every install; `admin` / `editor` / `viewer` roles and per-workspace roles |

Walkthrough: [User guide → SQL Editor](docs/user-guide.md#sql-editor).

## Workflow

Optional designer for scheduled and triggered jobs (SQL, HTTP, files, email/SMS).
The UI lives in Fox Schema; a **separate engine process** (`apps/workflow-server`,
port **8081**) runs them. The published Docker image does not start that process.

```bash
export WORKFLOW_ENGINE_TOKEN="$(openssl rand -hex 32)"
export FOXFLOW_ENCRYPTION_KEY="$(openssl rand -hex 32)"
npm run dev:with-workflow
```

Then **Workflow → Engine → Enabled**. Runbook: [docs/workflow.md](docs/workflow.md).
User steps: [User guide → Workflow](docs/user-guide.md#workflow).

## Schema Sync

Point Fox at a **source** and a **target**. It introspects both, shows a color-coded
diff, then generates DDL to align the target (dry-run by default).

![Fox Schema demo — connect, compare, migration SQL](docs/demo/foxschema-demo.gif)

- **Schema diff** — tables, columns, keys, indexes, constraints, views, routines…
- **Migration generation** — reviewable target-dialect DDL
- **Cross-dialect aware** — fewer false positives (e.g. Postgres → MySQL)
- **Safe apply** — dry-run default; skip-on-error optional; history recorded
- **Credentials encrypted at rest** — passwords never returned to the browser

Cross-dialect demo:

![Cross-dialect compare](docs/demo/cross-dialect-sqlite-postgres.gif)

## Docker (self-host)

```bash
docker run -d --name foxschema \
  -p 3210:3210 \
  -v foxschema_data:/data \
  5nickels/foxschema:latest
```

Open **http://localhost:3210**. Guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Supported dialects

PostgreSQL · CockroachDB · YugabyteDB · MySQL · MariaDB · TiDB · SQL Server ·
Azure SQL · Oracle · IBM Db2 · SQLite · DuckDB · ClickHouse · Amazon Redshift

MongoDB and Redis run a SQL subset in the editor (single-table SELECT, INSERT,
UPDATE, DELETE; Redis keys read as tables) — no schema compare. One product —
Docker image includes Db2 on linux/amd64.

## Package notes (npm)

The published `foxschema` CLI is built from **TypeScript** and ships as **Node ESM**
(`"type": "module"`) with a `types` entry for tooling. Native drivers may load as
CommonJS at runtime. Requires **Node ≥ 22.5**.

## How it's built

| Workspace | Role |
|-----------|------|
| `packages/sql` | Dialect knowledge: SQL generation, compare, splitting, type mapping (pure, zero deps) |
| `packages/db` | Node runtime: drivers, pooling, migration execution (depends on `packages/sql`) |
| `packages/server` | Fastify HTTP API, feature modules, metadata store |
| `packages/workflow-engine` | Workflow runtime, stores, built-in pipes |
| `apps/web` | React UI + the entry point that serves it (CLI launcher + Docker) |
| `apps/cli` | `foxschema` CLI, desktop shortcut, TUI |
| `apps/workflow-server` | Workflow engine HTTP process (`:8081`) |
| `apps/e2e` | Playwright tests against dockerized databases |

Maintainers: [docs/publish.md](docs/publish.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Copyright 2024–2026 Huy Phan `<huyplb@gmail.com>` and [tedious-code](https://github.com/tedious-code)
contributors. See [NOTICE](NOTICE) and [LICENSE](LICENSE) (Apache-2.0).

Keep copyright / NOTICE / LICENSE when you fork or redistribute — stripping
authorship notices is not allowed under the License.
