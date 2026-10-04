/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test IDs for page objects and tests, checked against the web app.
 *
 *   await clickWhen(page, byTestId('git-commit-push'));
 *   await page.locator(byTestId(`git-run-${fileName}`)).click();
 *   await page.getByTestId(TestIds.git.CommitMigrationDialog.gitCommitPush).click();
 *
 * `TestId` is every ID in the web app (generated, see docs/testing/TEST_IDS.md),
 * so a typo or a removed ID is a compile error instead of a 30-second timeout.
 */
import type { TestId } from '../generated/test-ids.js';

export { TestIds, type TestId } from '../generated/test-ids.js';

/** The CSS selector that finds the element with this test ID. */
export const byTestId = (id: TestId): string => `[data-testid="${id}"]`;
