/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertSafeEmbeddedDatabasePath,
  isProtectedEmbeddedDatabasePath,
} from './embedded-db-guard.js';

const dir = mkdtempSync(join(tmpdir(), 'fox-embedded-guard-'));
const metaPath = join(dir, 'custom-meta.sqlite');
const keyPath = join(dir, '.app_encryption_key');
const userPath = join(dir, 'user-app.db');
const symlinkToMeta = join(dir, 'alias.db');
const hardlinkToMeta = join(dir, 'hardlink.db');

writeFileSync(metaPath, 'meta');
writeFileSync(keyPath, 'secret');
writeFileSync(userPath, 'user');
symlinkSync(metaPath, symlinkToMeta);
linkSync(metaPath, hardlinkToMeta);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('embedded-db-guard', () => {
  it('allows :memory: and ordinary user database paths', () => {
    expect(isProtectedEmbeddedDatabasePath(':memory:')).toBe(false);
    expect(isProtectedEmbeddedDatabasePath('file::memory:?cache=shared')).toBe(false);
    expect(isProtectedEmbeddedDatabasePath(userPath, [metaPath])).toBe(false);
    expect(() => assertSafeEmbeddedDatabasePath(userPath, [metaPath])).not.toThrow();
  });

  it('blocks internal basenames, WAL/SHM companions, file: URIs, and encryption key files', () => {
    const blocked = [
      '/data/foxschema.db',
      '/data/foxschema.db-wal',
      '/data/foxschema.db-shm',
      '/data/foxschema.db-journal',
      '/data/workflow-engine.sqlite',
      '/data/.app_encryption_key',
      'file:///data/foxschema.db?mode=ro',
      'file:%2Fdata%2Ffoxschema.db',
      keyPath,
      '/tmp/safe.db\0/other',
    ];
    for (const target of blocked) {
      expect(isProtectedEmbeddedDatabasePath(target, [metaPath]), target).toBe(true);
      expect(() => assertSafeEmbeddedDatabasePath(target, [metaPath]), target).toThrow(
        /internal metadata database/i,
      );
    }
  });

  it('blocks custom configured metadata DB paths, symlinks, and hard links to them', () => {
    expect(isProtectedEmbeddedDatabasePath(metaPath, [metaPath])).toBe(true);
    expect(isProtectedEmbeddedDatabasePath(symlinkToMeta, [metaPath])).toBe(true);
    expect(isProtectedEmbeddedDatabasePath(hardlinkToMeta, [metaPath])).toBe(true);
    expect(isProtectedEmbeddedDatabasePath(`file://${symlinkToMeta}`, [metaPath])).toBe(true);
    expect(isProtectedEmbeddedDatabasePath(`file://${hardlinkToMeta}`, [metaPath])).toBe(true);
  });
});
