/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Repository URLs, branch names, folders, and which addresses a shared
 * server refuses to dial.
 */
import { describe, expect, it } from 'vitest';
import { normalizeBranchName, normalizeFolder, normalizeRemoteUrl } from './git-url';
import { isPrivateAddress } from './git-http';

describe('repository URLs', () => {
  it('accepts https and normalises it', () => {
    expect(normalizeRemoteUrl(' https://github.com/acme/db.git/ ')).toBe('https://github.com/acme/db.git');
    expect(normalizeRemoteUrl('https://dev.azure.com/org/proj/_git/repo')).toBe('https://dev.azure.com/org/proj/_git/repo');
  });

  it('refuses other schemes, credentials, queries and garbage', () => {
    expect(() => normalizeRemoteUrl('http://github.com/a/b.git')).toThrow(/https/);
    expect(normalizeRemoteUrl('http://localhost:3000/r.git', true)).toBe('http://localhost:3000/r.git');
    expect(() => normalizeRemoteUrl('ssh://git@github.com/a/b.git')).toThrow(/https/);
    expect(() => normalizeRemoteUrl('git@github.com:a/b.git')).toThrow();
    expect(() => normalizeRemoteUrl('file:///srv/repo.git')).toThrow(/https/);
    expect(() => normalizeRemoteUrl('https://me:token@github.com/a/b.git')).toThrow(/out of the URL/);
    expect(() => normalizeRemoteUrl('https://github.com/a/b.git?x=1')).toThrow(/query/);
  });
});

describe('branch names', () => {
  it('accepts what git accepts', () => {
    for (const ok of ['main', 'feature/orders-index', 'release-1.2', 'ana/fix_42']) expect(normalizeBranchName(ok)).toBe(ok);
  });

  it('refuses what git refuses', () => {
    for (const bad of ['', 'a b', 'a..b', '-x', 'x/', '/x', 'x.lock', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'HEAD', 'a/.b', 'x.', 'a@{b'])
      expect(() => normalizeBranchName(bad), bad).toThrow();
  });
});

describe('folders', () => {
  it('normalises slashes and refuses leaving the repository', () => {
    expect(normalizeFolder('/db/migrations/')).toBe('db/migrations');
    expect(normalizeFolder('db\\migrations')).toBe('db/migrations');
    expect(normalizeFolder('')).toBe('');
    expect(() => normalizeFolder('../outside')).toThrow();
    expect(() => normalizeFolder('a/.git/hooks')).toThrow();
  });
});

describe('private addresses', () => {
  it('refuses loopback, private, link-local, CGNAT and metadata addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isPrivateAddress(a), a).toBe(true);
  });

  it('allows public addresses', () => {
    for (const a of ['140.82.112.3', '8.8.8.8', '172.32.0.1', '2606:50c0:8000::153']) expect(isPrivateAddress(a), a).toBe(false);
  });
});
