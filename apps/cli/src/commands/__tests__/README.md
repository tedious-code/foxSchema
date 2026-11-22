# CLI command tests

Unit tests for the `fox` CLI commands (`apps/cli/src/commands/*.ts`). They run in the
root Vitest workspace — `apps/cli/**/*.test.ts` is included in
[`vitest.config.ts`](../../../../../vitest.config.ts), with aliases mapping the
`@foxschema/web/*` subpath exports to their source files so tests need no build step.

Run them:

```bash
npx vitest run apps/cli            # just the CLI tests
npx vitest run                     # whole workspace
```

## What these tests cover

Command **wiring and observable behavior**, not the database layer:

- argument validation and required-flag errors,
- which output branch runs (summary / `--json` / `--ddl`, dry-run vs `--execute`),
- process exit codes (e.g. `compare` exits 1 on drift, `--no-fail` suppresses it),
- confirmation flow (`migrate --execute` prompts; `--yes` skips it),
- that the two dialects are threaded into `compare()` for cross-dialect runs,
- that `--scope` is parsed to `DbObjectType[]` and forwarded to `loadScopedTables`.

The actual providers, `MigrationModule.execute`, and the encrypted store are **mocked** —
real-database behavior belongs in the engine unit tests (`packages/sql`, `packages/db`) and the
Playwright E2E suite (`apps/e2e`).

## Mocking patterns

The commands depend on three seams; spy on these rather than the DB drivers:

| Seam | Module | Notes |
|------|--------|-------|
| Connection resolution | `runtime/connectionRef` → `resolveRef` | Returns `{ dialect, option, schema }`. Mock once per source, once per target. |
| Engine singletons | `runtime/engine` → `compareModule`, `sqlGenerator`, `migrationModule`, `connectionModule`, `loadScopedTables` | `loadScopedTables` is a module function; `*Module` are instances — `vi.spyOn(engine.compareModule, 'compare')`. |
| Encrypted store | `runtime/store` → `getContext` | Returns `{ userId, connections, history }`; `connections`/`history` are stores with async methods. Build a fake with `vi.fn()`s. |

Interactive prompts come from `@inquirer/prompts`; mock the whole module:

```ts
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn().mockResolvedValue(true) }));
```

Two gotchas that bit the first draft of these tests:

- `parseScope('tables,views')` returns `['TABLE','VIEW']` (uppercased `DbObjectType[]`),
  **not** a `{ tables: true }` object.
- `--json` output is `JSON.stringify(result, null, 2)`, so assert `'"added": 1'`
  (space after the colon), not `'"added":1'`.

## Adding a test for a new command

1. Read the command in `apps/cli/src/commands/` and note which of the three seams it
   touches (most touch `resolveRef` + `engine`).
2. `vi.spyOn` each seam; for `getContext`, return a fake context whose store methods are
   `vi.fn()`s.
3. Silence output with `vi.spyOn(console, 'log').mockImplementation(() => {})` and assert
   against the spy's calls.
4. `vi.restoreAllMocks()` in `beforeEach` so `process.exitCode` and spies don't leak
   between tests.
