/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openWorkflowFile } from './workflow-files.js';

let root = '';
let outside = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fox-files-root-'));
  outside = await mkdtemp(join(tmpdir(), 'fox-files-outside-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('openWorkflowFile', () => {
  it('refuses a path outside the root before anything is read or written', async () => {
    await expect(openWorkflowFile('../escape.csv', root)).rejects.toThrow(/outside the workflow files directory/);
    await expect(openWorkflowFile(join(outside, 'x.csv'), root)).rejects.toThrow(/outside/);
  });

  it('refuses a link inside the root that points out of it', async () => {
    await writeFile(join(outside, 'secret.txt'), 'nope');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await expect(openWorkflowFile('link.txt', root)).rejects.toThrow(/outside/);
  });

  it('writes, appends into a new folder, and reads back', async () => {
    const file = await openWorkflowFile('out/report.csv', root);
    expect(await file.isEmpty()).toBe(true);
    await file.append('a,b\n');
    await file.append('1,2\n');
    expect(await file.readText()).toBe('a,b\n1,2\n');
    expect(await file.isEmpty()).toBe(false);
    await file.write('fresh\n');
    expect(await readFile(join(root, 'out/report.csv'), 'utf8')).toBe('fresh\n');
  });

  it('reads a head, dropping a partial last line only when asked', async () => {
    await writeFile(join(root, 'in.txt'), 'line one\nline two\nline three\n');
    const file = await openWorkflowFile('in.txt', root);
    expect(await file.readHead(13)).toEqual({ text: 'line one\nline', truncated: true });
    expect(await file.readHead(13, { wholeLines: true })).toEqual({ text: 'line one', truncated: true });
    expect(await file.readHead(1000)).toEqual({ text: 'line one\nline two\nline three\n', truncated: false });
  });
});
