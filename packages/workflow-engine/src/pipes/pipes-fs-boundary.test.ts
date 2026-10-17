/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * File pipes reach the filesystem only through `openWorkflowFile`, which
 * resolves the configured path inside the workflow files root first. A pipe
 * that imported `node:fs` itself would read or write wherever its config
 * pointed — `/etc/passwd`, `~/.ssh/authorized_keys` — as the engine's user,
 * and nothing else would notice.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PIPES = __dirname;

/** The only files under pipes/ that may touch the filesystem directly. */
const ALLOWED = new Set(['utility/file-root.ts', 'utility/workflow-files.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const FS_IMPORT = /(?:from\s+|import\(\s*|require\(\s*)['"](?:node:)?fs(?:\/promises)?['"]/;

describe('file pipes and the filesystem', () => {
  it('finds the pipe sources it guards', () => {
    expect(sources(PIPES).length).toBeGreaterThan(20);
  });

  it('lets only the root-confined module import node:fs', () => {
    const offenders = sources(PIPES)
      .map((path) => relative(PIPES, path))
      .filter((rel) => !ALLOWED.has(rel) && FS_IMPORT.test(readFileSync(join(PIPES, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
