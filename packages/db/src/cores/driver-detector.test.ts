/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { DriverDetector, readInstalledPackageVersion } from './driver-detector.js';

describe('readInstalledPackageVersion', () => {
  it('reads pg from its package.json, not from the module export', () => {
    const version = readInstalledPackageVersion('pg');
    expect(version).toMatch(/^\d+\.\d+/);
    expect(DriverDetector.checkDialect('postgres')).toMatchObject({
      packageName: 'pg',
      installed: true,
      version,
    });
  });

  it('returns nothing for a package that is not installed', () => {
    expect(readInstalledPackageVersion('foxschema-no-such-driver-package')).toBeUndefined();
  });
});

describe('DriverDetector.detectAll', () => {
  it('reuses one check for dialects that share a package', () => {
    const pg = DriverDetector.detectAll().filter((info) => info.packageName === 'pg');
    expect(pg.length).toBeGreaterThan(1);
    expect(new Set(pg.map((info) => info.installed)).size).toBe(1);
    expect(new Set(pg.map((info) => info.version)).size).toBe(1);
  });
});
