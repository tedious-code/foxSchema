# Documentation

One file per topic, in one folder per kind of document. If two pages used to say the same thing, this list names the one to read.

Living documents (guides, architecture, conventions, testing, security) describe the tree as it is. Specs, plans and release notes are history: they record what was proposed and why, and their paths can be stale. A plan whose design was later replaced says so in a banner at its top.

Not supported, and not documented on purpose: a desktop app (Tauri), Winget, and the separate FoxAgent/FoxFlow engine (archived; its engine runs inside `packages/server`, see [workflow.md](guides/workflow.md)).

## Where a new document goes

| Folder | What belongs there |
| --- | --- |
| [`guides/`](guides/) | Instructions: install, use, deploy, operate, ship. Step by step, for a reader doing the task. |
| [`architecture/`](architecture/) | How the system is built and where code lives. Kept in step with the code. |
| [`conventions/`](conventions/) | Rules for writing code here: naming, dependencies, file headers. |
| [`specs/`](specs/) | Proposals not built yet: what a feature should do and why. A spec moves to `plans/` once work starts. |
| [`plans/`](plans/) | Implementation plans and schedules, dated `YYYY-MM-DD-topic.md`, with a status line at the top. |
| [`testing/`](testing/) | How to write and run tests; test plans and their results in `testing/test-plans/`, dated manual test scripts in `testing/manual/`. |
| [`security/`](security/) | The CI security process and the checklist for every change. |
| [`releases/`](releases/) | One file per shipped version, plus the summary. Not edited after the version ships. |

Images and video for the README live in `demo/` and `images/`.

## Start here

| Topic | Document |
| --- | --- |
| What the product is and how to install it | [README](../README.md), [install.md](guides/install.md) |
| How to use the app | [user-guide.md](guides/user-guide.md) |
| Where code lives | [CODE_MAP.md](architecture/CODE_MAP.md) |
| What each feature is, what it touches, and how to plan work on it | [FEATURE_MAP.md](architecture/FEATURE_MAP.md) ([interactive map](architecture/feature-map.html)) |
| How the system is put together | [ARCHITECTURE.md](architecture/ARCHITECTURE.md) |
| How to work in this repo | [CONTRIBUTING.md](../CONTRIBUTING.md), [AGENTS.md](../AGENTS.md) |

## Guides (instructions)

| Topic | Document |
| --- | --- |
| Install channels (npm, Homebrew, Windows, Docker) | [install.md](guides/install.md) |
| Using the app, screen by screen | [user-guide.md](guides/user-guide.md) |
| Server deploy, env, encryption, SSO, email | [DEPLOYMENT.md](guides/DEPLOYMENT.md) |
| Sending email through Gmail (Nodemailer, and Fox) | [gmail-smtp.md](guides/gmail-smtp.md) |
| Workflow engine | [workflow.md](guides/workflow.md) |
| Cutting a release | [publish.md](guides/publish.md) |
| Refresh the Homebrew formula after npm publish | [packaging/homebrew/README.md](../packaging/homebrew/README.md) |
| Db2 OS user example | [examples/db2-os-user.md](guides/examples/db2-os-user.md) |
| SQL editor examples | [examples/sql-editor/README.md](guides/examples/sql-editor/README.md) |

Homebrew install steps live only in [install.md](guides/install.md#homebrew-macos). The packaging readme does not repeat them.

## Architecture

| Topic | Document |
| --- | --- |
| Repo layout, dialects, migration flow | [ARCHITECTURE.md](architecture/ARCHITECTURE.md) |
| Where code lives, and where a change belongs | [CODE_MAP.md](architecture/CODE_MAP.md) |
| Every feature, its routes, tables and tests | [FEATURE_MAP.md](architecture/FEATURE_MAP.md) |
| HTTP server, logging, what is never logged | [BACKEND_ARCHITECTURE.md](architecture/BACKEND_ARCHITECTURE.md) |
| Feature folders and how to add one | [FEATURE-MODULE-GUIDE.md](architecture/FEATURE-MODULE-GUIDE.md) |
| Which feature may import which | [FEATURE-DEPENDENCY-RULES.md](architecture/FEATURE-DEPENDENCY-RULES.md) |
| Dialect hooks | [packages/sql/src/providers/DIALECTS.md](../packages/sql/src/providers/DIALECTS.md) |
| What `@foxschema/features` holds | [packages/features/README.md](../packages/features/README.md) |
| CLI commands and flags | [apps/cli/README.md](../apps/cli/README.md) |
| How the CLI command, TUI and web component tests are set up | [apps/cli/src/commands/\_\_tests\_\_/README.md](../apps/cli/src/commands/__tests__/README.md), [apps/cli/src/tui/\_\_tests\_\_/README.md](../apps/cli/src/tui/__tests__/README.md), [apps/web/src/frontend/test/README.md](../apps/web/src/frontend/test/README.md) |

`architecture/feature-map.html` is generated: edit `architecture/feature-map/` or `FEATURE_MAP.md`, then run `npm run docs:feature-map`.

## Conventions

| Topic | Document |
| --- | --- |
| File and symbol names (enforced by `naming.test.ts`) | [CONVENTIONS.md](conventions/CONVENTIONS.md) |
| Adding and updating dependencies | [DEPENDENCY_POLICY.md](conventions/DEPENDENCY_POLICY.md) |
| Copyright header for new source files | [COPYRIGHT_HEADER.txt](conventions/COPYRIGHT_HEADER.txt) |

## Specs (proposed, not built)

| Topic | Document |
| --- | --- |
| Excel and Google Sheets import | [excel-and-sheets-import.md](specs/excel-and-sheets-import.md) |

## Plans and schedules (history)

Finished or in-progress implementation plans. Each starts with its status. Do not treat them as the map of the code; the current map is [CODE_MAP.md](architecture/CODE_MAP.md).

| Topic | Document |
| --- | --- |
| Feature-module schedule | [2026-10-10-feature-architecture.md](plans/2026-10-10-feature-architecture.md) |
| Package split (the old core package → `@foxschema/sql` + `@foxschema/db`; superseded) | [package-split.md](plans/package-split.md) |
| Splitting `@foxschema/sql` into sql + features + the Db2 add-on, and the submodules (#626–#628) | [2026-11-21-sql-package-split-review.md](plans/2026-11-21-sql-package-split-review.md) |
| Signed Cloudflare CDN UI bundle updates (#636) | [2026-11-22-signed-ui-bundles.md](plans/2026-11-22-signed-ui-bundles.md) |
| Backend moved out of the web app; Express removed | [backend-extraction.md](plans/backend-extraction.md) |
| API layout and the decisions still open | [api-restructure.md](plans/api-restructure.md) |
| Frontend moved to `app/` + `features/` + `shared/` | [frontend-refactor.md](plans/frontend-refactor.md) |
| Workspaces and admin policy | [2026-10-09-workspaces-and-admin-policy.md](plans/2026-10-09-workspaces-and-admin-policy.md) |
| SQL editor | [sql-editor.md](plans/sql-editor.md) |
| Data Compare at 2,000 rows, SQL Tracer, Redis keys as tables | [2026-10-17-data-compare-and-sql-tracer.md](plans/2026-10-17-data-compare-and-sql-tracer.md) |
| Test ids | [2026-10-03-test-ids.md](plans/2026-10-03-test-ids.md) |
| Migrations in Git | [2026-10-02-migrations-in-git.md](plans/2026-10-02-migrations-in-git.md) |
| Diff colors and safety gates | [2026-06-30-diff-colors-and-safety-gates.md](plans/2026-06-30-diff-colors-and-safety-gates.md) |
| Service status on Home (status shipped; start/stop later) | [2026-11-01-service-status.md](plans/2026-11-01-service-status.md) |
| Safe column change: planner, Utils screen, in-place default, all 14 SQL engines | [2026-11-01-safe-column-change.md](plans/2026-11-01-safe-column-change.md) |
| Schema versioning, revert and history graph (built as Lokee Weave / Snapshots) | [schema-versioning-and-revert.md](plans/schema-versioning-and-revert.md) |
| Server Beam: move data between databases with JS + SQL (built, v1) | [server-beam.md](plans/server-beam.md) |

## Testing

| Topic | Document |
| --- | --- |
| How to write an end-to-end test | [WRITING_E2E.md](testing/WRITING_E2E.md) |
| How to run it against the engines, and failures that are not bugs | [RUNNING_E2E.md](testing/RUNNING_E2E.md) |
| Generated test-id catalog | [TEST_IDS.md](testing/TEST_IDS.md) |

### Test plans and results

| Topic | Document |
| --- | --- |
| Feature and dialect test plan, and its first results | [2026-10-25-feature-and-dialect-test-plan.md](testing/test-plans/2026-10-25-feature-and-dialect-test-plan.md), [2026-10-26-feature-and-dialect-test-results.md](testing/test-plans/2026-10-26-feature-and-dialect-test-results.md) |
| Review features across every engine | [2026-10-06-review-features-test-plan.md](testing/test-plans/2026-10-06-review-features-test-plan.md) |
| Seed test matrix, and the migration-ordering bugs it found | [2026-07-01-seed-test-matrix.md](testing/test-plans/2026-07-01-seed-test-matrix.md), [2026-07-01-migration-ordering-bugs.md](testing/test-plans/2026-07-01-migration-ordering-bugs.md) |
| Manual test: Google Cloud secrets and Drop Type | [2026-11-12-manual-test-gcp-and-drop-type.md](testing/manual/2026-11-12-manual-test-gcp-and-drop-type.md) |

## Security

| Topic | Document |
| --- | --- |
| Checklist for every change | [checklist.md](security/checklist.md) |
| CI security jobs and how to maintain them | [security-process.md](security/security-process.md) |
| Reporting a vulnerability | [SECURITY.md](../SECURITY.md) |

## Releases

Every shipped version in one page: [releases/SUMMARY.md](releases/SUMMARY.md). The per-version files, listed in [releases/README.md](releases/README.md), are the GitHub Release bodies and are not updated after the version ships.
