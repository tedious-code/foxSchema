/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The rule these encode: this endpoint names database files and directories,
 * and nothing else. Every test that adds a file type is asking whether it
 * would still be true.
 */
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  browseDirectory,
  browseErrorMessage,
  isDatabaseFile,
  parentOf,
  resolveBrowsePath,
} from './file-browse';

const root = await mkdtemp(join(tmpdir(), 'fox-browse-'));

await mkdir(join(root, 'projects'));
await mkdir(join(root, '.hidden'));
await writeFile(join(root, 'app.db'), 'x');
await writeFile(join(root, 'analytics.duckdb'), 'x');
await writeFile(join(root, 'Notes.SQLite3'), 'x');
await writeFile(join(root, 'secrets.env'), 'AWS_SECRET=1');
await writeFile(join(root, 'id_rsa'), 'PRIVATE KEY');
await writeFile(join(root, 'dump.sql'), 'select 1');
await writeFile(join(root, '.env'), 'TOKEN=1');

afterAll(() => {
  /* tmpdir is the OS's to clean */
});

describe('isDatabaseFile', () => {
  it.each([
    ['app.db', true],
    ['app.DB', true],
    ['store.sqlite', true],
    ['store.sqlite3', true],
    ['warehouse.duckdb', true],
    ['x.ddb', true],
    ['dump.sql', false],
    ['secrets.env', false],
    ['id_rsa', false],
    ['db', false],
    ['notes.dbx', false],
  ])('%s → %s', (name, want) => {
    expect(isDatabaseFile(name)).toBe(want);
  });
});

describe('browseDirectory', () => {
  it('lists directories and database files, and nothing else', async () => {
    const result = await browseDirectory(root);
    const names = result.entries.map((e) => e.name);
    expect(names).toContain('projects');
    expect(names).toContain('app.db');
    expect(names).toContain('analytics.duckdb');
    expect(names).toContain('Notes.SQLite3');
    // The point of the filter: a signed-in user cannot use this to enumerate
    // keys, dumps or dotfiles.
    expect(names).not.toContain('secrets.env');
    expect(names).not.toContain('id_rsa');
    expect(names).not.toContain('dump.sql');
    expect(names).not.toContain('.env');
    expect(names).not.toContain('.hidden');
  });

  it('never returns file contents — only name, size and mtime', async () => {
    const file = (await browseDirectory(root)).entries.find((e) => e.name === 'app.db');
    expect(Object.keys(file!).sort()).toEqual(['kind', 'modifiedAt', 'name', 'path', 'size']);
  });

  it('puts directories before files, each sorted case-insensitively', async () => {
    const kinds = (await browseDirectory(root)).entries.map((e) => e.kind);
    expect(kinds.indexOf('dir')).toBeLessThan(kinds.indexOf('file'));
    const files = (await browseDirectory(root)).entries.filter((e) => e.kind === 'file');
    expect(files.map((f) => f.name)).toEqual(['analytics.duckdb', 'app.db', 'Notes.SQLite3']);
  });

  it('lists the containing directory when handed a file', async () => {
    // The picker reopens on the last used path, which is a file.
    const result = await browseDirectory(join(root, 'app.db'));
    expect(result.path).toBe(root);
  });

  it('reports a parent for a nested directory and null at the root', async () => {
    expect((await browseDirectory(join(root, 'projects'))).parent).toBe(root);
    expect(parentOf('/')).toBeNull();
  });

  it('rejects a path with a NUL byte instead of normalizing it', () => {
    const home = '/home/someone';
    expect(resolveBrowsePath('/etc\0/../../root', home)).toBe(home);
  });

  it('resolves a relative path against home, not the process cwd', () => {
    // cwd is wherever the service was started from — not a place the user has
    // any model of.
    expect(resolveBrowsePath('data', '/home/someone')).toBe('/home/someone/data');
    expect(resolveBrowsePath('', '/home/someone')).toBe('/home/someone');
    expect(resolveBrowsePath(undefined, '/home/someone')).toBe('/home/someone');
  });

  it('follows a symlinked directory', async () => {
    const link = join(root, 'linked');
    await symlink(join(root, 'projects'), link, 'dir');
    expect((await browseDirectory(link)).entries).toEqual([]);
  });

  it('throws for a missing directory, with a message that names it', async () => {
    const missing = join(root, 'nope');
    await expect(browseDirectory(missing)).rejects.toThrow();
    await expect(
      browseDirectory(missing).catch((e: unknown) => browseErrorMessage(e, missing))
    ).resolves.toContain('No such directory');
  });
});

describe('browseErrorMessage', () => {
  it.each([
    ['ENOENT', 'No such directory'],
    ['EACCES', 'Permission denied'],
    ['EPERM', 'Permission denied'],
    ['ENOTDIR', 'Not a directory'],
  ])('%s reads as "%s"', (code, expected) => {
    const err = Object.assign(new Error('raw'), { code });
    expect(browseErrorMessage(err, '/some/dir')).toContain(expected);
  });

  it('falls back to the error message for anything else', () => {
    expect(browseErrorMessage(new Error('disk on fire'), '/x')).toBe('disk on fire');
  });
});
