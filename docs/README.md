# Documentation

One file per topic. If two pages used to say the same thing, this list names the one to read.

Living documents describe the tree as it is. Plans and release notes are history: they record why a change was made, and their paths can be stale.

## Start here

| Topic | Document |
| --- | --- |
| What the product is and how to install it | [README](../README.md), [install.md](install.md) |
| How to use the app | [user-guide.md](user-guide.md) |
| Where code lives | [CODE_MAP.md](CODE_MAP.md) |
| What each feature is, what it touches, and how to plan work on it | [FEATURE_MAP.md](FEATURE_MAP.md) |
| How the system is put together | [ARCHITECTURE.md](ARCHITECTURE.md) |
| File and symbol names | [CONVENTIONS.md](CONVENTIONS.md) |
| How to work in this repo | [CONTRIBUTING.md](../CONTRIBUTING.md), [AGENTS.md](../AGENTS.md) |

## Run and ship

| Topic | Document |
| --- | --- |
| Install channels (npm, Homebrew, Windows, Docker) | [install.md](install.md) |
| Server deploy, env, encryption, SSO | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Workflow engine | [workflow.md](workflow.md) |
| Cutting a release | [publish.md](publish.md) |
| Refresh the Homebrew formula after npm publish | [packaging/homebrew/README.md](../packaging/homebrew/README.md) |
| Dependency updates | [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md) |
| Security process | [security/security-process.md](security/security-process.md) |
| Db2 OS user example | [examples/db2-os-user.md](examples/db2-os-user.md) |
| SQL editor examples | [examples/sql-editor/README.md](examples/sql-editor/README.md) |

Homebrew install steps live only in [install.md](install.md#homebrew-macos). The packaging readme does not repeat them.

## Architecture (current)

| Topic | Document |
| --- | --- |
| Repo layout, dialects, migration flow | [ARCHITECTURE.md](ARCHITECTURE.md) |
| HTTP server, logging, what is never logged | [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) |
| Feature folders and how to add one | [architecture/FEATURE-MODULE-GUIDE.md](architecture/FEATURE-MODULE-GUIDE.md) |
| Which feature may import which | [architecture/FEATURE-DEPENDENCY-RULES.md](architecture/FEATURE-DEPENDENCY-RULES.md) |
| Dialect hooks | [packages/sql/src/providers/DIALECTS.md](../packages/sql/src/providers/DIALECTS.md) |

## Testing

| Topic | Document |
| --- | --- |
| How to write an end-to-end test | [testing/WRITING_E2E.md](testing/WRITING_E2E.md) |
| Generated test-id catalog | [testing/TEST_IDS.md](testing/TEST_IDS.md) |

## Plans (history)

Finished or in-progress design notes. Do not treat them as the map of the code. The current map is [CODE_MAP.md](CODE_MAP.md).

| Topic | Document |
| --- | --- |
| Package split (`packages/core` → sql + db) | [plans/package-split.md](plans/package-split.md) |
| Backend moved out of the web app; Express removed | [plans/backend-extraction.md](plans/backend-extraction.md) |
| API layout and the decisions still open | [plans/api-restructure.md](plans/api-restructure.md) |
| Frontend moved to `app/` + `features/` + `shared/` | [plans/frontend-refactor.md](plans/frontend-refactor.md) |
| Feature-module schedule | [plans/2026-10-10-feature-architecture.md](plans/2026-10-10-feature-architecture.md) |
| Workspaces and admin policy | [plans/2026-10-09-workspaces-and-admin-policy.md](plans/2026-10-09-workspaces-and-admin-policy.md) |
| SQL editor | [plans/sql-editor.md](plans/sql-editor.md) |
| Data Compare at 2,000 rows, SQL Tracer, Redis keys as tables | [plans/2026-10-17-data-compare-and-sql-tracer.md](plans/2026-10-17-data-compare-and-sql-tracer.md) |
| Test ids | [plans/2026-10-03-test-ids.md](plans/2026-10-03-test-ids.md) |
| Migrations in Git | [plans/2026-10-02-migrations-in-git.md](plans/2026-10-02-migrations-in-git.md) |
| Seed and migration ordering | [plans/2026-07-01-seed-test-matrix.md](plans/2026-07-01-seed-test-matrix.md), [plans/2026-07-01-migration-ordering-bugs.md](plans/2026-07-01-migration-ordering-bugs.md) |
| Diff colors and safety gates | [plans/2026-06-30-diff-colors-and-safety-gates.md](plans/2026-06-30-diff-colors-and-safety-gates.md) |
| Schema versioning | [plans/schema-versioning-and-revert.md](plans/schema-versioning-and-revert.md) |
| Server beam | [plans/server-beam.md](plans/server-beam.md) |
| Excel and Sheets import | [plans/excel-and-sheets-import.md](plans/excel-and-sheets-import.md) |
| Feature review test plan | [plans/2026-10-06-review-features-test-plan.md](plans/2026-10-06-review-features-test-plan.md) |

## Releases

Every shipped version in one page: [releases/SUMMARY.md](releases/SUMMARY.md). The per-version files, listed in [releases/README.md](releases/README.md), are the GitHub Release bodies and are not updated after the version ships.
