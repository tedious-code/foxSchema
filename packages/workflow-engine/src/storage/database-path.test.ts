/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workflow engine — moved from FoxAgent (packages/storage/src/database-path.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_DATABASE_FILENAME,
  resolveDatabasePath,
} from './database-path.js';

const original = process.env.FOXFLOW_DB_PATH;

afterEach(() => {
  if (original === undefined) delete process.env.FOXFLOW_DB_PATH;
  else process.env.FOXFLOW_DB_PATH = original;
});

describe('resolveDatabasePath', () => {
  it('anchors the default to the repo root, not the cwd', () => {
    delete process.env.FOXFLOW_DB_PATH;
    const fromRepoRoot = resolveDatabasePath();

    // The regression this guards: the server, scheduler and worker scripts run
    // with a workspace as cwd, so a cwd-relative default gave each process a
    // different database.
    const cwd = process.cwd();
    try {
      process.chdir(join(cwd, 'apps', 'cli'));
      expect(resolveDatabasePath()).toBe(fromRepoRoot);
      process.chdir(join(cwd, 'packages', 'workflow-engine'));
      expect(resolveDatabasePath()).toBe(fromRepoRoot);
    } finally {
      process.chdir(cwd);
    }

    expect(isAbsolute(fromRepoRoot)).toBe(true);
    expect(fromRepoRoot.endsWith(DEFAULT_DATABASE_FILENAME)).toBe(true);
  });

  it('lets FOXFLOW_DB_PATH win over the default', () => {
    process.env.FOXFLOW_DB_PATH = '/var/lib/foxflow/prod.sqlite';
    expect(resolveDatabasePath()).toBe('/var/lib/foxflow/prod.sqlite');
  });

  it('lets an explicit argument win over the environment', () => {
    process.env.FOXFLOW_DB_PATH = '/var/lib/foxflow/prod.sqlite';
    expect(resolveDatabasePath('/tmp/other.sqlite')).toBe('/tmp/other.sqlite');
  });

  it('treats an empty FOXFLOW_DB_PATH as unset', () => {
    delete process.env.FOXFLOW_DB_PATH;
    const fallback = resolveDatabasePath();
    process.env.FOXFLOW_DB_PATH = '';
    expect(resolveDatabasePath()).toBe(fallback);
  });

  it('passes SQLite’s own forms through untouched', () => {
    delete process.env.FOXFLOW_DB_PATH;
    expect(resolveDatabasePath(':memory:')).toBe(':memory:');
    expect(resolveDatabasePath('file:x?mode=memory')).toBe(
      'file:x?mode=memory',
    );
  });

  it('resolves an explicit relative path against the cwd', () => {
    delete process.env.FOXFLOW_DB_PATH;
    // Only the *default* is anchored; asking for a relative path is a
    // deliberate choice and still means "relative to where I am".
    expect(resolveDatabasePath('scratch.sqlite')).toBe(
      join(process.cwd(), 'scratch.sqlite'),
    );
  });
});
