# SQL Editor — multi-credential query workbench (3 phased PRs)

> **Historical plan** (the three PRs shipped). Paths and constraints below are
> stale: `packages/core` is now `packages/sql` + `packages/db`; the API lives in
> `packages/server` (not `apps/web/src/backend`); SQLite is read-write; ports are
> **3210** / **5173**. Current map: [CODE_MAP.md](../CODE_MAP.md). User walkthrough:
> [user-guide.md](../user-guide.md#sql-editor). Agent notes:
> `.cursor/rules/sql-editor-agent-memory.mdc`.

## Context

FoxSchema can compare/migrate schemas but has no way to run ad-hoc SQL and look at
**data**. The user wants a SQL Editor view **in the web UI** (not CLI):
browse-style layout (schema objects left, editor right), multi-tab, per-tab credential
checklist (run the same query against 1..N saved connections and compare data across
environments), per-statement syntax indicators + run checkboxes, schema-aware
autocomplete with alias support, and result grids groupable by credential (vertical) or
side-by-side (horizontal).

**Decisions locked with the user:** any SQL allowed with a confirmation dialog when a
write/DDL statement is included (SQLite/ClickHouse writes fail with friendly per-cell
errors — their adapters are SELECT-only); per-statement checkboxes live in a
**statement strip** below the editor (gutter keeps the green-✓/amber-⚠ status icons);
delivery as **3 phased PRs**, each leaving gates green.

**Verified reuse:** `ConnectionFactory.executeQuery<T>()` returns rows for all 14
dialects; `resolveRef` closure in `routes.ts` decrypts saved connections server-side;
`rateLimit()` in `api/rate-limit.ts`; Monaco via `@monaco-editor/react` +
`monaco-setup.ts` (`monacoLanguage()`, themes); `sql-formatter` + `utils/formatSql.ts`;
`SavedConnectionSummary` list in `useSyncStore.connections`; zustand `persist` +
`partialize` pattern (never persist credentials); vite aliases `@foxschema/core` →
`packages/core/src/browser.ts`, so pure core modules are shared frontend/backend.
**Gaps (net-new):** statement splitter, syntax heuristic, data-execution endpoint,
tabs UI, data grid, completion provider. No timeouts/cancel (deferred, documented).

---

## PR 1 — core plumbing + usable single-tab editor

**Ships:** switch to "SQL Editor" view, type SQL, check N credentials, Run → all
statements execute against every checked credential, results in by-credential layout.

### 1a. Core: splitter + heuristics — NEW `packages/core/src/modules/sql-splitter.ts`
- `splitSqlStatements(sql): SplitStatement[]` where
  `SplitStatement = { text, start, end, startLine, endLine, terminated }`.
  Single-pass scanner aware of: `--`/`#` line comments, `/* */` block comments,
  `'…'`/`"…"`/backtick/`[bracket]` quoting, Postgres `$tag$…$tag$` dollar quotes,
  `;` terminators. NOT handled v1 (document): procedural BEGIN…END bodies with
  internal semicolons.
- `checkStatement(stmt): { level: 'ok'|'warn'; reasons: string[] }` — heuristic only:
  terminated with `;`, balanced quotes/parens, starts with known SQL keyword.
  UI copy must say "looks complete", not "valid".
- `isWriteStatement(stmt): boolean` — leading-keyword check (INSERT/UPDATE/DELETE/
  CREATE/ALTER/DROP/TRUNCATE/MERGE/GRANT/REVOKE) for the confirm dialog.
- Export all from `packages/core/src/browser.ts` (and `index.ts` for backend).
- Tests: `packages/core/src/modules/sql-splitter.test.ts` — comments, dollar quotes,
  quoted semicolons, unterminated final statement, CRLF, empty input, check matrix.

### 1b. Backend: `POST /api/sql/execute`
- NEW `apps/web/src/backend/api/sql-execute.ts`: pure helpers
  `runStatements(dialect, option, statements, maxRows)` + `shapeRows(rows, maxRows)`.
  Route registered inside `createApiRoutes` (`routes.ts`) so it closes over `resolveRef`.
- Request: `{ ...ConnectionRef, statements: string[], maxRows?: number }`.
  Clamp maxRows to [1, 5000], default 500; max 25 statements; reject empty statements.
  Server trusts the client split (same as `/migration/execute`).
- **Fan-out is client-side** — one request per credential, `Promise.allSettled` in the
  store. Progressive arrival for free; dead DB can't stall others; no new protocol.
- Statements run sequentially via `ConnectionFactory.executeQuery`; per-statement error
  isolation: `results: Array<{ok:true, columns, rows, rowCount, truncated, durationMs}
  | {ok:false, error, durationMs}>` (always 200 once ref resolves).
- Row shaping: columns = union of `Object.keys` over first 50 rows; rows as arrays in
  column order; **BigInt → string, Date → ISO** server-side (JSON.stringify throws on
  BigInt). Empty set → `columns: []` (v1 limitation, UI shows "0 rows").
- Row cap = slice-after-fetch + `truncated: true` flag (no LIMIT injection — dialect-
  variant, needs a parser). Truncation notice suggests adding LIMIT.
- `rateLimit({ windowMs: 60_000, max: 60 })`.
- Tests: shaping/clamping helpers pure-unit; `runStatements` against a seeded
  better-sqlite3 file (no HTTP harness exists in repo — test the helper, not Express).

### 1c. Frontend skeleton
- `activeView: 'sync' | 'sqlEditor'` in `apps/web/src/frontend/store/uiStore.ts`
  (already persists); view switcher buttons in `TopToolbar.tsx`; `App.tsx` `Workspace`
  renders `<SqlEditorView/>` instead of tree+detail panels when `sqlEditor`.
- NEW `apps/web/src/frontend/store/useSqlEditorStore.ts` (single tab in PR 1):
  `{ sql, selectedConnectionIds, resultsByConnection, running }` +
  `execute()` (split → confirm-if-`isWriteStatement` → fan out), reading
  `useSyncStore.connections`.
- NEW `apps/web/src/frontend/components/sql-editor/`:
  - `SqlEditorView.tsx` — left: `ConnectionChecklist`; right: editor pane + Run button
    + `ResultsPanel`.
  - `ConnectionChecklist.tsx` — checkboxes over `SavedConnectionSummary` (`[DIALECT]
    name` styling + missing-password session-prompt pattern from TopToolbar).
  - `SqlEditorPane.tsx` — NEW Monaco wrapper (copy BASE_OPTIONS/theme wiring from
    `SqlEditor.tsx`, leave that file untouched), `glyphMargin: true`, editable;
    on change (debounced ~200ms) split+check → `createDecorationsCollection` with
    glyph classes for ✓/⚠ per statement start line. Lazy + Suspense like existing.
  - `ResultsPanel.tsx` (byCredential layout only in PR 1) + `DataGrid.tsx` — plain
    `<table>`, sticky header, `NULL` dim-italic, ~200-char cell truncation w/ tooltip,
    footer `N rows · X ms` + amber truncation notice; rose error card per failed cell.
- New frontend `api/sqlApi.ts` following `schemaApi.ts` conventions (`parseJson`,
  `{error}` shape).
- Write-confirm dialog: portal modal listing the write statements + credential count,
  styled like `DeployConfirmDialog.tsx`.

## PR 2 — tabs, statement selection, layouts, persistence

- Multi-tab: `tabs: SqlTab[]` (`{id, title, sql, selectedConnectionIds, checkedStatements,
  layout}`), `activeTabId`, tab bar (add/close/rename via double-click), results keyed
  per tab (not persisted).
- `StatementStrip.tsx` between editor and results: one row per split statement —
  status icon, checkbox, truncated preview (`#1 ✓ SELECT * FROM users…`); click row →
  reveal statement in editor. Execute runs checked statements; **none checked → first
  statement** (the agreed default). `setSql` that changes statement count resets checks.
- Layout toggle per tab: `byCredential` (vertical stack of credential rows, each row's
  statement results horizontally scrollable) | `sideBySide` (one section per statement,
  credential results as columns). Same data, orientation flip.
- Persistence: `zustand/persist` key `foxschema-sql-editor`, partialize →
  `{tabs: [{id,title,sql,selectedConnectionIds,layout}], activeTabId}`. Connection ids
  are safe (not credentials); drop stale ids against `useSyncStore.connections` on
  render. Never persist results/schemaCache/checkedStatements.
- CSV export per grid: `utils/exportCsv.ts` (quote-escaped join + Blob download).
- Format button reusing `utils/formatSql.ts`.
- Store reducer tests (tab add/close/toggle/check-reset).

## PR 3 — schema intelligence

- `SqlSchemaExplorer.tsx` — NEW slim left tree (do NOT reuse SchemaTreePanel — it's
  hard-wired to compareResult/diff state): connection picker on top, tables → columns,
  click-to-insert identifier at cursor; reuse `TYPE_META` icons. Data via existing
  `loadSchema()` (POST /schema/load), cached in store `schemaCache[connectionId]`.
- `extractTableAliases(sql)` in `sql-splitter.ts` (+tests): regex over
  `FROM|JOIN|UPDATE|INTO <ident> [AS] <alias>` with keyword blacklist
  (where/on/set/join/left/right/inner/outer/group/order/limit/using).
- `completion.ts` — one `monaco.languages.registerCompletionItemProvider` per language
  id (mysql/pgsql/sql), registered once at first mount, reading active tab's
  schemaCache via module-level getter (prevents duplicate-provider leaks). Logic:
  `alias.` → that table's columns; `table.` → its columns; otherwise table names +
  light keywords. Suggestions from all checked connections' schemas, deduped.
- Pre-flight friendly warning when write statements target sqlite/clickhouse
  credentials (their adapters can't execute writes).

## Verification (each PR)

1. `cd apps/web && npx tsc --noEmit` and root `npx vitest run` green.
2. Browser (vite 5199 + API 3001, per-session `preview_start name:"web"` + tsx API):
   seed two SQLite files with the same table but divergent rows
   (`sqlite3 /tmp/foxa.db` / `/tmp/foxb.db` — pattern proven this session), save both
   as connections, then: type 2 SELECTs + 1 broken statement → gutter shows ✓✓⚠;
   check both credentials → Run → by-credential layout shows 2 rows × per-statement
   grids with the divergent data visible; broken statement shows rose error card;
   PR 2: toggle side-by-side, reload page → tabs/sql persist; PR 3: type `SELECT u.`
   after `FROM t1 u` → column suggestions appear.
3. Write-confirm: type an UPDATE, Run → confirmation dialog appears; on the SQLite
   credential the cell shows the friendly readonly error.

## Out of scope

- **CLI / TUI** — the interactive SQL editor is web-only. No `foxschema sql`
  command, Ink screen, or CLI execute path in this plan or follow-ups unless revisited.

## Deferred / documented limitations

- No query timeout/cancel (only clickhouse/sqlserver honor `timeout.queryMs`); runaway
  queries hold a pooled connection. Needs its own follow-up.
- No cross-statement session state (each statement may get a different pooled
  connection — temp tables/SET/transactions don't carry). `executeOnConnection` is the
  later fix if needed.
- Empty result sets show no column names (rows-derived metadata).
- Syntax indicator is a heuristic ("looks complete"), not a parser.
- Row cap slices after fetch — driver still transfers the full result.