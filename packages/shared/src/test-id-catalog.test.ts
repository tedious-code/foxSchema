/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The test-ID catalog stays true, and coverage only goes up.
 *
 * `docs/testing/TEST_IDS.md` and `apps/e2e/src/generated/test-ids.ts` are
 * generated from the web app's JSX; a test that reads a stale one finds an ID
 * that is gone, or misses a new one. And every button, text box, select and
 * textarea should carry a test ID, so Playwright tests can find it: the number
 * without one may only fall (see docs/plans/2026-10-03-test-ids.md).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as catalog from '../../../scripts/test-ids/extract-test-ids.mjs';

/**
 * Controls in the web app without a test ID. Lower it when you add IDs; the
 * test fails until you do, so the progress is kept. Raising it is the one
 * thing not to do: give the new control an ID instead.
 */
const CONTROLS_WITHOUT_TEST_ID = 395;

const found = catalog.collectTestIds();
const read = (rel: string) => fs.readFileSync(path.join(catalog.REPO_ROOT, rel), 'utf8');

describe('the test-ID catalog', () => {
  it('is up to date with the web app (regenerate: npm run test-ids)', () => {
    expect(read(catalog.MARKDOWN_PATH), catalog.MARKDOWN_PATH).toBe(catalog.renderMarkdown(found));
    expect(read(catalog.TYPESCRIPT_PATH), catalog.TYPESCRIPT_PATH).toBe(catalog.renderTypeScript(found));
  });

  it('only ever gains coverage', () => {
    const missing = found.missing.length;
    const where = found.missing
      .slice(0, 10)
      .map((m) => `${m.file}:${m.line} <${m.element}>`)
      .join('\n');
    expect(missing, `A new control has no data-testid. Give it one:\n${where}`).toBeLessThanOrEqual(CONTROLS_WITHOUT_TEST_ID);
    expect(missing, `Coverage went up: lower CONTROLS_WITHOUT_TEST_ID to ${missing} to keep it.`).toBe(CONTROLS_WITHOUT_TEST_ID);
  });
});
