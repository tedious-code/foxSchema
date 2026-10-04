#!/usr/bin/env node
/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The test IDs a change adds and removes, as Markdown for a PR comment.
 *
 *   node scripts/test-ids/diff-test-ids.mjs origin/main
 *
 * It compares the `TestId` type in apps/e2e/src/generated/test-ids.ts at the
 * base with the working tree's. The catalog test keeps that file true to the
 * web app, so nothing needs building. A removed ID matters most: a test
 * outside this repo, or a recorded flow, may still look for it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPESCRIPT_PATH = 'apps/e2e/src/generated/test-ids.ts';
export const MARKER = '<!-- test-id-diff -->';

/** The IDs in a generated test-ids.ts, `{…}` for a part filled in at run time; empty before `TestId` existed. */
export function idsIn(text) {
  const start = text.indexOf('export type TestId =');
  if (start < 0) return new Set();
  const ids = new Set();
  for (const line of text.slice(start).split('\n').slice(1)) {
    const m = /^ {2}\| (['`])(.*)\1;?$/.exec(line);
    if (!m) break;
    const raw = m[1] === "'" ? m[2].replace(/\\(['\\])/g, '$1') : m[2].replace(/\$\{string\}/g, '{…}').replace(/\\([`$\\])/g, '$1');
    ids.add(raw);
  }
  return ids;
}

/** A PR comment: what was added and removed, or that nothing was. */
export function renderDiff(before, after) {
  const added = [...after].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !after.has(id)).sort();
  const lines = [MARKER, '### Test IDs', ''];
  if (!added.length && !removed.length) {
    lines.push('No test IDs added or removed.');
    return lines.join('\n') + '\n';
  }
  const list = (title, ids, note) => {
    if (!ids.length) return;
    lines.push(`**${title}** (${ids.length})${note ? ` · ${note}` : ''}`, '');
    const shown = ids.slice(0, 100);
    for (const id of shown) lines.push(`- \`${id}\``);
    if (ids.length > shown.length) lines.push(`- …and ${ids.length - shown.length} more`);
    lines.push('');
  };
  list('Removed', removed, 'a test or recorded flow outside this repo may still use these');
  list('Added', added);
  lines.push('`{…}` is a part filled in at run time. The full tree: `docs/testing/TEST_IDS.md`.');
  return lines.join('\n') + '\n';
}

function atRef(ref) {
  try {
    return execFileSync('git', ['show', `${ref}:${TYPESCRIPT_PATH}`], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: diff-test-ids.mjs <base-ref>');
    process.exit(2);
  }
  const before = idsIn(atRef(base));
  const after = idsIn(fs.readFileSync(path.join(REPO_ROOT, TYPESCRIPT_PATH), 'utf8'));
  // Before the base had a TestId type there is nothing to compare with.
  if (!before.size) process.exit(0);
  process.stdout.write(renderDiff(before, after));
}
