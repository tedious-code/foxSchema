/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The test-ID catalog stays true, and coverage only goes up.
 *
 * `docs/testing/TEST_IDS.md` and `apps/e2e/src/generated/test-ids.ts` are
 * generated from the web app's JSX; a test that reads a stale one finds an ID
 * that is gone, or misses a new one. Every button, text box, select and
 * textarea carries a test ID, so Playwright tests can find it, and no static ID
 * names two different things (see docs/plans/2026-10-03-test-ids.md).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as catalog from '../../../scripts/test-ids/extract-test-ids.mjs';

const found = catalog.collectTestIds();
const read = (rel: string) => fs.readFileSync(path.join(catalog.REPO_ROOT, rel), 'utf8');

describe('the test-ID catalog', () => {
  it('is up to date with the web app (regenerate: npm run test-ids)', () => {
    expect(read(catalog.MARKDOWN_PATH), catalog.MARKDOWN_PATH).toBe(catalog.renderMarkdown(found));
    expect(read(catalog.TYPESCRIPT_PATH), catalog.TYPESCRIPT_PATH).toBe(catalog.renderTypeScript(found));
  });

  it('gives every control a test ID', () => {
    const where = found.missing.map((m) => `${m.file}:${m.line} <${m.element}>`).join('\n');
    expect(found.missing, `Give each a data-testid (see docs/testing/TEST_IDS.md):\n${where}`).toEqual([]);
  });

  it('never gives two components the same static ID', () => {
    const where = catalog.duplicates(found).map(([id, at]) => `${id}: ${at.join(', ')}`).join('\n');
    expect(where, 'A selector finds the first; give each its own ID, or list it in SHARED_IDS').toBe('');
  });

  it('lists in SHARED_IDS only IDs that are still shared', () => {
    for (const id of Object.keys(catalog.SHARED_IDS)) {
      const files = new Set(found.entries.filter((e) => e.pattern === id).map((e) => e.file));
      expect(files.size, `${id} is no longer shared: remove it from SHARED_IDS`).toBeGreaterThan(1);
    }
  });
});
