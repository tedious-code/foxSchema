/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The shell commands a GitHub Actions workflow runs, read from its `run:`
 * keys: one-line values, and `run: |` blocks line by line, with `\`
 * continuations joined and whitespace collapsed. Enough for the plain
 * workflows in this repository; no YAML parser is installed at the root.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const indentOf = (line) => line.length - line.trimStart().length;
const squash = (cmd) => cmd.replace(/\s+/g, ' ').trim();

/** Every command a workflow's text runs, in order. */
export function runCommands(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // `run: …` or `- run: …`, read without a regular expression.
    let key = lines[i].trimStart();
    if (key.startsWith('- ')) key = key.slice(2).trimStart();
    if (!key.startsWith('run:')) continue;
    const value = key.slice('run:'.length).trim();
    if (value !== '|' && value !== '>' && value !== '|-' && value !== '>-') {
      out.push(squash(value.replace(/^(['"])(.*)\1$/, '$2')));
      continue;
    }
    // A block: every following line indented deeper than `run:` itself.
    const keyIndent = indentOf(lines[i]) + (lines[i].trimStart().startsWith('-') ? 2 : 0);
    let pending = '';
    for (i = i + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() && indentOf(line) <= keyIndent) {
        i--;
        break;
      }
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (t.endsWith('\\')) {
        pending += t.slice(0, -1) + ' ';
        continue;
      }
      out.push(squash(pending + t));
      pending = '';
    }
    if (pending) out.push(squash(pending));
  }
  return out;
}

/** Whether a workflow runs on pull requests. */
export function runsOnPullRequests(text) {
  return /^\s*pull_request(_target)?:/m.test(text) || /^on:\s*\[?[^\n]*\bpull_request\b/m.test(text);
}

/** `{ file, commands }` for each workflow in `dir`. */
export function readWorkflows(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      return { file, pullRequest: runsOnPullRequests(text), commands: runCommands(text) };
    });
}
