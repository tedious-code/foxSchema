# Writing an e2e test

The e2e suite (`apps/e2e`) drives the real web app in Chromium with Playwright,
run by Vitest. Every button, text box, select and textarea has a `data-testid`,
and the catalog lists them, so a new test is mostly finding IDs and calling
page objects.

## 1. Find the screen's IDs

Open [`TEST_IDS.md`](TEST_IDS.md), go to the area (`## git`, `## sql-editor`…)
and the component. Each line is an ID, the element, and what it says on screen:

```
- **CommitMigrationDialog** · `features/git/components/CommitMigrationDialog.tsx`
  - `git-commit-note` · textarea · Commit message
  - `git-commit-push` · button · Commit & push
```

- `{name}` is a part filled in at run time: `git-run-{fileName}` is
  `git-run-20261003__add.sql` for that file.
- `button in FilterPicker` means a shared component draws it. The ID is
  written in this file and handed down as a prop.

## 2. Use a page object

`apps/e2e/src/pages` has one class per area: `AppPage` (compare), `SqlEditorPage`,
`LokeeHistoryPage`, `MigrationPage`, `AccessPage`, `WorkflowPage`,
`ConnectionModal`. Use their methods for the steps they already cover. When a
new step will be used by more than one test, add a method there.

## 3. Select by test ID

```ts
import { byTestId } from '../helpers/test-ids.js';

await clickWhen(page, byTestId('git-commit-push'));      // CSS selector
await page.locator(byTestId(`git-run-${fileName}`)).click();
await page.getByTestId('git-commit-note').fill('Add orders');
```

`byTestId` only accepts an ID the web app has (`TestId`, generated). A typo
or a removed ID does not compile, so you get an error before the test ever
waits 30 seconds. `TestIds` holds the same IDs as a tree, for autocomplete:
`TestIds.git.CommitMigrationDialog.gitCommitPush`.

Callbacks given to `page.evaluate` and `page.waitForFunction` run in the
browser, where `byTestId` does not exist. Write the selector out there:
`document.querySelector('[data-testid="lokee-summary"]')`. The catalog test
still checks it (see "What catches mistakes" below).

## 4. A skeleton

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { buildDriver, quitDriver } from '../helpers/driver.js';
import { byTestId } from '../helpers/test-ids.js';
import { WorkflowPage } from '../pages/WorkflowPage.js';

let driver: Page;
beforeAll(async () => {
  driver = await buildDriver(); // signed in
});
afterAll(async () => {
  await quitDriver(driver);
});

describe('Workflow runs', () => {
  it('lists runs for the selected workflow', async () => {
    const workflow = new WorkflowPage(driver);
    await workflow.openView();
    await workflow.openTab('runs');
    expect(await driver.locator(byTestId('workflow-runs-live')).isVisible()).toBe(true);
  });
});
```

Save it as `apps/e2e/src/tests/<area>-<what>.test.ts`.

## 5. Run it

With the dev stack up (`npm run dev`; DB containers for the dialect tests, see
`docs/ARCHITECTURE.md`):

```bash
cd apps/e2e && npx vitest run src/tests/workflow-runs.test.ts
```

- `HEADLESS=false` shows the browser.
- `npx playwright codegen http://localhost:5173` records the clicks you make
  as `getByTestId(...)` steps, a usable first draft to paste in.

## Ask an agent

The repo's `.mcp.json` registers a small MCP server over the catalog
(`scripts/test-ids/mcp-server.mjs`). Claude Code offers it when you open the
repo, and it gives an agent three tools:

- `find_test_id`: words in, IDs out. "push button in the commit dialog" gives
  `git-commit-push`.
- `describe_screen`: every ID one component draws.
- `scaffold_test`: a test file for one component, built on `byTestId` and the
  page object for its area. The steps the flow describes are live; the
  screen's other controls are listed, commented out.

Together with a browser-driving MCP (Playwright's), an agent can find the IDs
for a flow and write the test that uses them.

## A control without an ID

That should not happen: the catalog test fails on one. If you add a control,
give it an ID named `<area>-<screen>-<control>[-<key>]`. For example,
`git-commit-push`, or `blueprint-fk-drop-${fk.name}` for one per row, where
the key is the row's stable React key and never its index. Then regenerate
the catalog:

```bash
npm run test-ids
```

## What catches mistakes

`packages/shared/src/test-id-catalog.test.ts`, in the normal `npx vitest run`:

| Mistake | Caught by |
| --- | --- |
| A new control has no `data-testid` | "gives every control a test ID" |
| Two components use the same static ID | "never gives two components the same static ID" |
| An e2e selector names an ID the app no longer has, in a page object, a test or an `evaluate` callback | "knows every test ID the e2e suite uses" |
| `TEST_IDS.md` or `test-ids.ts` not regenerated | "is up to date with the web app" |

In `byTestId(...)` calls, the e2e typecheck (`cd apps/e2e && npx tsc --noEmit`)
catches the same mistakes earlier.

Two lists in `scripts/test-ids/extract-test-ids.mjs` record exceptions, each
with its reason:

- `SHARED_IDS`: one ID two components draw on purpose, never both on screen
  at once.
- `REMOVED_IDS`: IDs a test checks are gone.
